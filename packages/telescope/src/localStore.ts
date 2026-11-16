import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Zip, ZipPassThrough } from 'fflate';

import {
  ArtifactPathSchema,
  IdentityManifestSchema,
  ResultManifestSchema,
  ScenarioManifestSchema,
  TestIdSchema,
} from './contracts.js';
import { generateTestID } from './helpers.js';
import { redactLocalConfig, reusableLocalOptions } from './localOptions.js';
import type {
  LaunchOptions,
  LocalDefinition,
  LocalJob,
  LocalResultSummary,
  LocalScriptReference,
  SavedConfig,
  ScenarioStepResult,
} from './types.js';

const MAX_FILES = 5000;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Writes one private metadata record without exposing a partially written JSON file. */
function atomicJson(filename: string, value: unknown): void {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Persists directory entry changes where the host filesystem supports directory fsync. */
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Reads bounded JSON data, treating missing/corrupt optional diagnostics as unavailable. */
function optionalJson<T = unknown>(filename: string): T | null {
  try {
    if (
      fs.lstatSync(filename).isSymbolicLink() ||
      fs.statSync(filename).size > MAX_FILE_BYTES
    )
      return null;
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Returns whether a resolved filesystem path is contained in its selected root. */
function isInside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

/** Owns a filesystem-backed local result library and its private control metadata. */
export class LocalStore {
  readonly root: string;
  readonly metadataRoot: string;
  private readonly lockFile: string;
  private readonly guardDirectory: string;
  private readonly lockToken = crypto.randomUUID();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(resultsDir: string) {
    fs.mkdirSync(path.resolve(resultsDir), { recursive: true });
    this.root = fs.realpathSync(path.resolve(resultsDir));
    this.metadataRoot = path.join(this.root, '.telescope');
    for (const directory of [
      '',
      'jobs',
      'definitions',
      'runs',
      'requests',
      'tmp',
    ]) {
      const full = path.join(this.metadataRoot, directory);
      fs.mkdirSync(full, { recursive: true, mode: 0o700 });
      if (
        fs.lstatSync(full).isSymbolicLink() ||
        !isInside(this.root, fs.realpathSync(full))
      ) {
        throw new Error(
          'Local metadata directories must remain inside the results directory',
        );
      }
    }
    this.lockFile = path.join(this.metadataRoot, 'workspace.lock');
    this.guardDirectory = path.join(this.metadataRoot, 'workspace.guard');
    this.acquireLock();
    this.heartbeat = setInterval(() => {
      try {
        this.withGuard(() => {
          const current = optionalJson<{ token: string }>(this.lockFile);
          if (current?.token === this.lockToken) this.writeLock();
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          console.error('Could not renew the local workspace lease');
      }
    }, 10_000);
    this.heartbeat.unref();
    try {
      this.recoverJobs();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private writeLock(): void {
    atomicJson(this.lockFile, {
      token: this.lockToken,
      pid: process.pid,
      host: os.hostname(),
      updatedAt: new Date().toISOString(),
    });
  }

  private withGuard<T>(operation: () => T): T {
    // Serializes initial claims, stale-lock recovery, and heartbeat replacement.
    // A leftover guard fails closed and requires an operator to confirm no owner remains.
    fs.mkdirSync(this.guardDirectory, { mode: 0o700 });
    try {
      return operation();
    } finally {
      fs.rmdirSync(this.guardDirectory);
    }
  }

  private assertLock(): void {
    if (
      optionalJson<{ token: string }>(this.lockFile)?.token !== this.lockToken
    )
      throw new Error(
        'The local workspace lease was lost; stop this service before continuing',
      );
  }

  private acquireLock(): void {
    this.withGuard(() => {
      try {
        fs.writeFileSync(
          this.lockFile,
          JSON.stringify({
            token: this.lockToken,
            pid: process.pid,
            host: os.hostname(),
            updatedAt: new Date().toISOString(),
          }),
          { flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (fs.lstatSync(this.lockFile).isSymbolicLink())
          throw new Error('Invalid workspace lock');
        const lock = optionalJson<{
          pid?: number;
          host?: string;
          updatedAt?: string;
        }>(this.lockFile);
        const recent = Date.now() - fs.statSync(this.lockFile).mtimeMs < 45_000;
        let live = false;
        if (lock?.host === os.hostname() && lock.pid) {
          try {
            process.kill(lock.pid, 0);
            live = true;
          } catch (ownerError) {
            // EPERM means the process may still be alive under another user.
            live = (ownerError as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        }
        if (recent || live)
          throw new Error(`Results directory is already in use: ${this.root}`);
        fs.rmSync(this.lockFile);
        fs.writeFileSync(
          this.lockFile,
          JSON.stringify({
            token: this.lockToken,
            pid: process.pid,
            host: os.hostname(),
            updatedAt: new Date().toISOString(),
          }),
          { flag: 'wx', mode: 0o600 },
        );
      }
    });
  }

  /** Releases only this process's workspace lock. */
  close(): void {
    clearInterval(this.heartbeat);
    if (
      optionalJson<{ token: string }>(this.lockFile)?.token === this.lockToken
    )
      fs.rmSync(this.lockFile, { force: true });
  }

  private recordPath(
    kind: 'jobs' | 'definitions' | 'runs',
    id: string,
  ): string {
    if (kind === 'runs') TestIdSchema.parse(id);
    else if (!UUID.test(id)) throw new Error('Invalid local record ID');
    return path.join(this.metadataRoot, kind, `${id}.json`);
  }

  private records<T>(kind: 'jobs' | 'definitions'): T[] {
    return fs
      .readdirSync(path.join(this.metadataRoot, kind))
      .filter(
        filename =>
          UUID.test(filename.replace(/\.json$/, '')) &&
          filename.endsWith('.json'),
      )
      .flatMap(filename => {
        const value = optionalJson<T>(
          path.join(this.metadataRoot, kind, filename),
        );
        return value ? [value] : [];
      });
  }

  private recoverJobs(): void {
    for (const job of this.jobs()) {
      if (!['queued', 'running', 'finalizing'].includes(job.status)) continue;
      job.status = 'interrupted';
      job.error =
        'Local service stopped before this job finished. Rerun explicitly to start a new capture.';
      this.saveJob(job);
    }
  }

  /** Returns persistent jobs, newest first. */
  jobs(): LocalJob[] {
    return this.records<LocalJob>('jobs').sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  /** Reads one persistent execution job. */
  job(id: string): LocalJob | null {
    return optionalJson<LocalJob>(this.recordPath('jobs', id));
  }

  /** Saves a job state and its capture association atomically per record. */
  saveJob(job: LocalJob): void {
    this.assertLock();
    job.updatedAt = new Date().toISOString();
    atomicJson(this.recordPath('jobs', job.id), job);
    if (job.testId) {
      const filename = this.recordPath('runs', job.testId);
      const previous = optionalJson<Record<string, unknown>>(filename) ?? {};
      atomicJson(filename, {
        ...previous,
        jobId: job.id,
        status: job.status,
        error: job.error,
        name: job.name,
        description: job.description,
        script: job.script,
      });
    }
  }

  /** Creates an idempotent queued job without persisting executable callbacks. */
  createJob(
    options: LaunchOptions,
    requestId?: string,
    maxQueue = 25,
    script?: LocalScriptReference,
    metadata?: { name?: string; description?: string },
  ): LocalJob {
    this.assertLock();
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify({ options, script, metadata }))
      .digest('hex');
    const requestFile = requestId
      ? path.join(
          this.metadataRoot,
          'requests',
          `${crypto.createHash('sha256').update(requestId).digest('hex')}.json`,
        )
      : null;
    if (requestFile) {
      const previous = optionalJson<{ jobId: string; digest: string }>(
        requestFile,
      );
      if (previous) {
        if (previous.digest !== digest)
          throw new Error(
            'This request ID was already used for different options',
          );
        const job = this.job(previous.jobId);
        if (job) return job;
      }
    }
    if (
      this.jobs().filter(job =>
        ['queued', 'running', 'finalizing'].includes(job.status),
      ).length >= maxQueue
    )
      throw new Error('The local job queue is full');
    const timestamp = new Date().toISOString();
    const job: LocalJob = {
      id: crypto.randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'queued',
      options,
      script,
      ...metadata,
    };
    this.saveJob(job);
    if (requestFile) atomicJson(requestFile, { jobId: job.id, digest });
    return job;
  }

  /** Returns reusable definitions with sensitive options removed. */
  definitions(): LocalDefinition[] {
    return this.records<LocalDefinition>('definitions')
      .map(definition => ({
        ...definition,
        options: reusableLocalOptions(definition.options),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates or updates a named reusable definition independently from captures. */
  saveDefinition(
    input: {
      name: string;
      description?: string;
      options: LaunchOptions;
      script?: LocalScriptReference;
    },
    id?: string,
  ): LocalDefinition {
    this.assertLock();
    const definitionId = id ?? crypto.randomUUID();
    const filename = this.recordPath('definitions', definitionId);
    const previous = optionalJson<LocalDefinition>(filename);
    if (id && !previous) throw new Error('Saved definition not found');
    const timestamp = new Date().toISOString();
    const definition: LocalDefinition = {
      id: definitionId,
      name: input.name,
      description: input.description,
      options: reusableLocalOptions(input.options),
      script: input.script,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    atomicJson(filename, definition);
    return definition;
  }

  /** Removes a saved definition without deleting its earlier captures. */
  deleteDefinition(id: string): void {
    this.assertLock();
    fs.rmSync(this.recordPath('definitions', id));
  }

  /** Resolves an existing artifact only after checking its real filesystem containment. */
  artifact(testId: string, relativePath: string): string {
    TestIdSchema.parse(testId);
    ArtifactPathSchema.parse(relativePath);
    if (relativePath.split('/').some(part => part.startsWith('.')))
      throw new Error('Private files cannot be served as artifacts');
    const directory = path.join(this.root, testId);
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error('Symlink result directories are not supported');
    const filename = path.resolve(directory, relativePath);
    if (!isInside(directory, filename))
      throw new Error('Invalid artifact path');
    const actual = fs.realpathSync(filename);
    if (
      !isInside(fs.realpathSync(directory), actual) ||
      !fs.statSync(actual).isFile()
    )
      throw new Error('Artifact is outside its capture directory');
    return actual;
  }

  /** Enumerates bounded capture files while excluding symlinks and private metadata. */
  artifacts(testId: string): Array<{ path: string; size: number }> {
    TestIdSchema.parse(testId);
    const directory = path.join(this.root, testId);
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error('Symlink result directories are not supported');
    const files: Array<{ path: string; size: number }> = [];
    const visit = (relative: string): void => {
      for (const entry of fs.readdirSync(path.join(directory, relative), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const item = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(item);
        else if (entry.isFile()) {
          this.artifact(testId, item);
          files.push({
            path: item,
            size: fs.statSync(path.join(directory, item)).size,
          });
          if (files.length > MAX_FILES)
            throw new Error('Capture contains too many files');
        }
      }
    };
    visit('');
    return files;
  }

  /** Reads a tolerant result summary without inferring success from config existence. */
  resultSummary(testId: string): LocalResultSummary | null {
    try {
      TestIdSchema.parse(testId);
      const config = optionalJson<SavedConfig>(
        this.artifact(testId, 'config.json'),
      );
      if (!config || typeof config.url !== 'string') return null;
      const metadata = optionalJson<{
        status?: string;
        name?: string;
        description?: string;
        publicationState?: string;
      }>(this.recordPath('runs', testId));
      if (
        metadata?.publicationState &&
        metadata.publicationState !== 'committed'
      )
        return null;
      let manifestStatus: string | undefined;
      const rawManifest = optionalJson(
        path.join(this.root, testId, 'result.json'),
      );
      if (rawManifest) {
        const parsed = ResultManifestSchema.safeParse(rawManifest);
        manifestStatus = parsed.success ? parsed.data.status : 'unsupported';
      }
      const date =
        typeof config.date === 'string' &&
        Number.isFinite(Date.parse(config.date))
          ? config.date
          : fs.statSync(path.join(this.root, testId)).mtime.toISOString();
      return {
        testId,
        url: String(redactLocalConfig(config.url)),
        date,
        name: metadata?.name,
        description: metadata?.description,
        browser: config.options?.browser ?? config.browserConfig?.engine,
        status: metadata?.status ?? manifestStatus ?? 'legacy',
        hasScreenshot: fs.existsSync(
          path.join(this.root, testId, 'screenshot.png'),
        ),
      };
    } catch {
      return null;
    }
  }

  /** Rescans CLI-created result folders instead of depending on a fragile catalog. */
  results(): LocalResultSummary[] {
    const results = fs
      .readdirSync(this.root, { withFileTypes: true })
      .flatMap(entry => {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          !TestIdSchema.safeParse(entry.name).success
        )
          return [];
        const result = this.resultSummary(entry.name);
        return result ? [result] : [];
      })
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    this.assertLock();
    atomicJson(path.join(this.metadataRoot, 'index.json'), results);
    return results;
  }

  /** Loads diagnostics for a capture or one validated scenario step. */
  result(testId: string, stepId?: string): Record<string, unknown> {
    const summary = this.resultSummary(testId);
    if (!summary) throw new Error('Result not found');
    const artifacts = this.artifacts(testId);
    const read = (relative: string): unknown => {
      try {
        return optionalJson(this.artifact(testId, relative));
      } catch {
        return null;
      }
    };
    const rawScenario = read('scenario.json');
    let scenario: unknown = null;
    let prefix = '';
    let selectedStep: ScenarioStepResult | undefined;
    if (artifacts.some(item => item.path === 'scenario.json')) {
      const parsed = ScenarioManifestSchema.safeParse(rawScenario);
      if (!parsed.success)
        throw new Error('Unsupported or invalid scenario format');
      scenario = parsed.data;
      selectedStep =
        parsed.data.steps.find(item => item.id === stepId) ??
        parsed.data.steps.find(
          item => item.status === 'failed' || item.status === 'cancelled',
        ) ??
        parsed.data.steps[0];
      prefix = `${selectedStep.artifactBase}/`;
    } else if (stepId) throw new Error('This capture has no scenario steps');
    return {
      summary,
      config: redactLocalConfig(read('config.json')),
      scenario,
      script: optionalJson<{ script?: LocalScriptReference }>(
        this.recordPath('runs', testId),
      )?.script,
      metrics: read(`${prefix}metrics.json`),
      resources: read(`${prefix}resources.json`),
      console: read(`${prefix}console.json`),
      har: read(`${prefix}pageload.har`),
      artifacts: artifacts.filter(
        item => !prefix || item.path.startsWith(prefix),
      ),
      artifactPrefix: prefix,
      selectedStep,
    };
  }

  /** Exports original capture files with additive portable identity for legacy imports. */
  exportResult(testId: string): AsyncGenerator<Uint8Array, void, unknown> {
    if (!this.resultSummary(testId)) throw new Error('Result not found');
    if (
      this.jobs().some(
        job =>
          job.testId === testId &&
          ['running', 'finalizing'].includes(job.status),
      )
    )
      throw new Error(
        'Wait for capture finalization before exporting this result',
      );
    const files = this.artifacts(testId);
    if (
      files.reduce((total, item) => total + item.size, 0) >
      3 * 1024 * 1024 * 1024
    )
      throw new Error('Capture exceeds the supported 3 GB ZIP export limit');
    const capture = ResultManifestSchema.safeParse(
      optionalJson(path.join(this.root, testId, 'result.json')),
    );
    const canonicalTestId = capture.success ? capture.data.testId : testId;
    const store = this;
    return (async function* (): AsyncGenerator<Uint8Array, void, unknown> {
      const pending: Uint8Array[] = [];
      let zipError: Error | undefined;
      const zip = new Zip((error, bytes) => {
        if (error) zipError = error;
        else if (bytes.length) pending.push(bytes);
      });
      try {
        for (const artifact of files) {
          const filename = store.artifact(testId, artifact.path);
          if (fs.statSync(filename).size !== artifact.size)
            throw new Error('A capture artifact changed during export');
          const entry = new ZipPassThrough(artifact.path);
          zip.add(entry);
          while (pending.length) yield pending.shift()!;
          const source = fs.createReadStream(filename, {
            highWaterMark: 64 * 1024,
          });
          let read = 0;
          try {
            for await (const chunk of source) {
              const bytes =
                typeof chunk === 'string'
                  ? Buffer.from(chunk)
                  : (chunk as Buffer);
              read += bytes.length;
              if (read > artifact.size)
                throw new Error('A capture artifact grew during export');
              entry.push(new Uint8Array(bytes), false);
              if (zipError) throw zipError;
              while (pending.length) yield pending.shift()!;
            }
          } finally {
            source.destroy();
          }
          if (read !== artifact.size)
            throw new Error(
              'A capture artifact became incomplete during export',
            );
          entry.push(new Uint8Array(), true);
          if (zipError) throw zipError;
          while (pending.length) yield pending.shift()!;
        }
        if (!files.some(item => item.path === 'identity.json')) {
          const identity = new ZipPassThrough('identity.json');
          zip.add(identity);
          identity.push(
            new TextEncoder().encode(
              JSON.stringify({ schemaVersion: 1, testId: canonicalTestId }),
            ),
            true,
          );
          while (pending.length) yield pending.shift()!;
        }
        zip.end();
        if (zipError) throw zipError;
        while (pending.length) yield pending.shift()!;
      } finally {
        zip.terminate();
      }
    })();
  }

  /** Removes one inactive capture without following symlink paths or touching other results. */
  deleteResult(testId: string): void {
    this.assertLock();
    TestIdSchema.parse(testId);
    if (
      this.jobs().some(
        job =>
          job.testId === testId &&
          ['queued', 'running', 'finalizing'].includes(job.status),
      )
    )
      throw new Error('Cancel the active test before removing its result');
    const directory = path.join(this.root, testId);
    if (
      fs.lstatSync(directory).isSymbolicLink() ||
      !isInside(this.root, fs.realpathSync(directory))
    )
      throw new Error('Invalid result directory');
    fs.rmSync(directory, { recursive: true });
    fs.rmSync(path.join(this.root, `${testId}.zip`), { force: true });
    fs.rmSync(this.recordPath('runs', testId), { force: true });
  }

  /** Imports a bounded safe archive, preserving validated identity without overwriting captures. */
  importResult(
    bytes: Buffer,
    beforePublish?: (receipt: { testId: string; duplicate: false }) => void,
  ): { testId: string; duplicate: boolean } {
    this.assertLock();
    if (bytes.length > 128 * 1024 * 1024) throw new Error('ZIP is too large');
    const archiveHash = crypto.createHash('sha256').update(bytes).digest('hex');
    let recoveringId: string | undefined;
    for (const filename of fs.readdirSync(
      path.join(this.metadataRoot, 'runs'),
    )) {
      const metadata = optionalJson<{
        importHash?: string;
        testId?: string;
        publicationState?: string;
      }>(path.join(this.metadataRoot, 'runs', filename));
      if (
        metadata?.importHash !== archiveHash ||
        !metadata.testId ||
        !TestIdSchema.safeParse(metadata.testId).success
      )
        continue;
      if (this.resultSummary(metadata.testId))
        return { testId: metadata.testId, duplicate: true };
      if (
        metadata.publicationState === 'staging' &&
        fs.existsSync(path.join(this.root, metadata.testId))
      )
        recoveringId = metadata.testId;
    }
    const entries = new AdmZip(bytes).getEntries();
    if (entries.length > MAX_FILES)
      throw new Error('ZIP contains too many entries');
    const normalized = new Map<string, (typeof entries)[number]>();
    let expanded = 0;
    for (const entry of entries) {
      const name = entry.entryName.replace(/\\/g, '/').replace(/\/$/, '');
      if (!name) continue;
      ArtifactPathSchema.parse(name);
      const mode =
        ((entry as { attr?: number }).attr ??
          (entry.header as { attr?: number }).attr ??
          0) >>> 16;
      if ((mode & 0o170000) === 0o120000)
        throw new Error('Symlink ZIP entries are not supported');
      if (normalized.has(name))
        throw new Error('ZIP contains duplicate normalized paths');
      normalized.set(name, entry);
      if (!entry.isDirectory) {
        if (entry.header.size > MAX_FILE_BYTES)
          throw new Error('ZIP entry is too large');
        expanded += entry.header.size;
        if (expanded > MAX_EXPANDED_BYTES)
          throw new Error('Expanded ZIP is too large');
      }
    }
    const configs = [...normalized.keys()]
      .filter(name => name.endsWith('/config.json') || name === 'config.json')
      .sort((a, b) => a.split('/').length - b.split('/').length);
    if (!configs.length) throw new Error('ZIP contains no config.json');
    const depth = configs[0].split('/').length;
    if (configs.filter(name => name.split('/').length === depth).length !== 1)
      throw new Error('ZIP contains ambiguous result roots');
    const prefix = configs[0].slice(0, -'config.json'.length);
    const configBytes = normalized.get(configs[0])!.getData();
    const config = JSON.parse(configBytes.toString('utf8')) as {
      url?: unknown;
      date?: unknown;
    };
    if (
      typeof config.url !== 'string' ||
      !['http:', 'https:'].includes(new URL(config.url).protocol)
    )
      throw new Error('Invalid result URL');
    const identity = normalized.get(`${prefix}identity.json`);
    const manifest = normalized.get(`${prefix}result.json`);
    let testId: string;
    if (identity)
      testId = IdentityManifestSchema.parse(
        JSON.parse(identity.getData().toString('utf8')),
      ).testId;
    else if (manifest)
      testId = ResultManifestSchema.parse(
        JSON.parse(manifest.getData().toString('utf8')),
      ).testId;
    else {
      const wrapper = prefix.replace(/\/$/, '');
      testId = TestIdSchema.safeParse(wrapper).success
        ? wrapper
        : (recoveringId ?? generateTestID());
    }
    if (
      identity &&
      manifest &&
      ResultManifestSchema.parse(
        JSON.parse(manifest.getData().toString('utf8')),
      ).testId !== testId
    )
      throw new Error('Archive identities disagree');
    const destination = path.join(this.root, testId);
    if (fs.existsSync(destination)) {
      const incoming = [...normalized.entries()]
        .filter(
          ([name, entry]) => !entry.isDirectory && name.startsWith(prefix),
        )
        .map(([name, entry]) => ({
          path: name.slice(prefix.length),
          data: entry.getData(),
        }))
        .filter(item => item.path !== 'identity.json');
      const existing = this.artifacts(testId).filter(
        item => item.path !== 'identity.json',
      );
      const identical =
        incoming.length === existing.length &&
        incoming.every(item => {
          if (
            !existing.some(
              file => file.path === item.path && file.size === item.data.length,
            )
          )
            return false;
          const actual = fs.readFileSync(this.artifact(testId, item.path));
          return actual.equals(item.data);
        });
      if (identical) {
        const metadataPath = this.recordPath('runs', testId);
        const metadata = optionalJson<Record<string, unknown>>(metadataPath);
        if (
          metadata?.publicationState === 'staging' &&
          metadata.importHash === archiveHash
        ) {
          atomicJson(metadataPath, {
            ...metadata,
            publicationState: 'committed',
          });
        } else if (
          metadata?.publicationState &&
          metadata.publicationState !== 'committed'
        ) {
          throw new Error(
            'This capture is still awaiting publication; retry after recovery completes',
          );
        }
        return { testId, duplicate: true };
      }
      throw new Error(
        `Capture ID already exists with different capture content: ${testId}`,
      );
    }
    const stage = fs.mkdtempSync(
      path.join(this.metadataRoot, 'tmp', 'import-'),
    );
    try {
      let written = 0;
      for (const [name, entry] of normalized) {
        if (entry.isDirectory || !name.startsWith(prefix)) continue;
        const relative = name.slice(prefix.length);
        ArtifactPathSchema.parse(relative);
        if (relative.split('/').some(part => part.startsWith('.')))
          throw new Error('Private archive paths are not allowed');
        const data = entry.getData();
        written += data.length;
        if (
          data.length > MAX_FILE_BYTES ||
          written > MAX_EXPANDED_BYTES ||
          data.length !== entry.header.size
        )
          throw new Error('ZIP size validation failed');
        const filename = path.join(stage, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        const descriptor = fs.openSync(filename, 'wx', 0o600);
        try {
          fs.writeFileSync(descriptor, data);
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        let ancestor = path.dirname(filename);
        while (isInside(stage, ancestor)) {
          syncDirectory(ancestor);
          if (ancestor === stage) break;
          ancestor = path.dirname(ancestor);
        }
      }
      const scenario = fs.existsSync(path.join(stage, 'scenario.json'))
        ? ScenarioManifestSchema.parse(
            JSON.parse(
              fs.readFileSync(path.join(stage, 'scenario.json'), 'utf8'),
            ),
          )
        : undefined;
      if (fs.existsSync(path.join(stage, 'result.json'))) {
        const capture = ResultManifestSchema.parse(
          JSON.parse(fs.readFileSync(path.join(stage, 'result.json'), 'utf8')),
        );
        if (capture.status === 'passed') {
          for (const required of scenario
            ? ['config.json', 'pageload.har', 'scenario.json']
            : [
                'config.json',
                'metrics.json',
                'resources.json',
                'console.json',
                'pageload.har',
              ]) {
            if (!fs.existsSync(path.join(stage, required)))
              throw new Error(`Passed capture is missing ${required}`);
          }
        }
        for (const [relative, descriptor] of Object.entries(
          capture.artifacts,
        )) {
          const filename = path.join(stage, relative);
          if (
            !fs.existsSync(filename) ||
            !fs.statSync(filename).isFile() ||
            fs.statSync(filename).size !== descriptor.size ||
            crypto
              .createHash('sha256')
              .update(fs.readFileSync(filename))
              .digest('hex') !== descriptor.sha256
          ) {
            throw new Error(
              `Capture integrity validation failed for ${relative}`,
            );
          }
        }
      }
      if (scenario)
        for (const step of scenario.steps) {
          if (step.status !== 'passed') continue;
          for (const required of [
            'metrics.json',
            'resources.json',
            'console.json',
            'pageload.har',
          ]) {
            if (!fs.existsSync(path.join(stage, step.artifactBase, required)))
              throw new Error(`Passed step ${step.id} is missing ${required}`);
          }
          const metrics = JSON.parse(
            fs.readFileSync(
              path.join(stage, step.artifactBase, 'metrics.json'),
              'utf8',
            ),
          ) as { navigationTiming?: unknown };
          if (step.kind === 'interaction' && metrics.navigationTiming)
            throw new Error(
              'Interaction metrics must not contain inherited navigation timing',
            );
        }
      atomicJson(this.recordPath('runs', testId), {
        testId,
        importHash: archiveHash,
        publicationState: 'staging',
        importedAt: new Date().toISOString(),
      });
      beforePublish?.({ testId, duplicate: false });
      fs.renameSync(stage, destination);
      syncDirectory(this.root);
      atomicJson(this.recordPath('runs', testId), {
        testId,
        importHash: archiveHash,
        publicationState: 'committed',
        importedAt: new Date().toISOString(),
      });
      return { testId, duplicate: false };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}
