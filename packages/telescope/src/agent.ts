import { execFile, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import playwright from 'playwright';
import { z } from 'zod';

import { getPackageVersion } from './packageVersion.js';
import { normalizeCLIConfig } from './config.js';
import { ScenarioManifestSchema } from './contracts.js';
import { DEFAULT_OPTIONS } from './defaultOptions.js';
import { listTrustedScripts, resolveTrustedScript } from './scriptRegistry.js';
import type {
  AgentOptions,
  CLIOptions,
  LaunchOptions,
  RunProgress,
  TestResult,
} from './types.js';

const PROTOCOL = 1;
const REQUEST_TIMEOUT = 20_000;
const MAX_ARCHIVE = 16 * 1024 * 1024;
const Id = z.string().uuid();
const Claim = z.object({
  id: Id,
  attemptId: Id,
  leaseToken: Id,
  leaseUntil: z.number(),
  resultId: z.string(),
  options: z
    .object({
      url: z.string().url(),
      browser: z.string().optional(),
      timeout: z.number().optional(),
    })
    .passthrough(),
});
const Spool = z.object({
  jobId: Id,
  attemptId: Id,
  leaseToken: Id,
  resultId: z.string(),
  executionState: z.enum(['passed', 'failed', 'cancelled', 'interrupted']),
  coreTestId: z.string().optional(),
  error: z.string().optional(),
  archiveChecksum: z.string().optional(),
  files: z
    .record(
      z.string(),
      z.object({ size: z.number().int().nonnegative(), sha256: z.string() }),
    )
    .optional(),
  capturePath: z.string().optional(),
  transferChecksum: z.string().optional(),
  deliveryAttempts: z.number().int().nonnegative().optional(),
  nextAttemptAt: z.number().optional(),
  lastError: z.string().optional(),
  blocked: z.boolean().optional(),
  workerPid: z.number().int().positive().optional(),
});

/** Runs an outbound, single-job Telescope executor for a trusted controller. */
export async function startAgent(options: AgentOptions): Promise<void> {
  const controller = new URL(options.controller);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
    controller.hostname,
  );
  if (
    controller.protocol !== 'https:' &&
    !(
      controller.protocol === 'http:' &&
      (loopback || options.allowInsecureHttp)
    )
  ) {
    throw new Error(
      'Agent controllers require HTTPS (HTTP is allowed only on loopback)',
    );
  }
  if (
    controller.username ||
    controller.password ||
    controller.search ||
    controller.hash
  )
    throw new Error(
      'Controller URL must not contain credentials, query, or fragment',
    );
  const token = (
    await readFile(path.resolve(options.tokenFile), 'utf8')
  ).trim();
  if (!/^[a-f0-9-]{36}\.[a-f0-9-]{72}$/.test(token))
    throw new Error('Invalid agent credential file');
  const allowHosts = (options.allowHosts ?? [])
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
  if (allowHosts.length === 0)
    throw new Error('An explicit --allowHosts target allowlist is required');
  if (allowHosts.some(host => !/^(\*\.)?[a-z0-9._:\[\]-]+$/.test(host)))
    throw new Error(
      'Allowlist entries must be hostnames/IPs or *.domain patterns',
    );
  const spoolDir = path.resolve(options.spoolDir ?? './telescope-agent-spool');
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  await chmod(spoolDir, 0o700);
  const lockPath = path.join(spoolDir, 'agent.lock');
  try {
    const previous = JSON.parse(await readFile(lockPath, 'utf8')) as {
      pid?: number;
    };
    if (previous.pid) {
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (alive) throw new Error('Another agent owns this spool directory');
    }
    await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  const sessionId = randomUUID();
  let maximumArchiveBytes = MAX_ARCHIVE;
  let stopping = options.signal?.aborted ?? false;
  let activeChild: ReturnType<typeof fork> | undefined;
  const stop = () => {
    stopping = true;
    if (activeChild?.connected) activeChild.send({ type: 'cancel' });
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  async function request(
    action: string,
    payload: unknown,
    attempt?: { attemptId: string; leaseToken: string },
    archive?: Uint8Array,
    artifact?: {
      path: string;
      size: number;
      filename: string;
      transferId: string;
    },
  ): Promise<Record<string, unknown>> {
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    headers.set('X-Telescope-Session', sessionId);
    if (attempt) {
      headers.set('X-Telescope-Attempt', attempt.attemptId);
      headers.set('X-Telescope-Lease', attempt.leaseToken);
    }
    headers.set(
      'Content-Type',
      artifact
        ? 'application/octet-stream'
        : archive
          ? 'application/zip'
          : 'application/json',
    );
    if (artifact) {
      headers.set('Content-Length', String(artifact.size));
      headers.set('X-Telescope-Transfer', artifact.transferId);
      headers.set(
        'X-Telescope-Artifact',
        encodeURIComponent(artifact.filename),
      );
    }
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      headers,
      body: artifact
        ? (Readable.toWeb(
            createReadStream(artifact.path),
          ) as ReadableStream<Uint8Array>)
        : archive
          ? new Blob([new Uint8Array(archive)], { type: 'application/zip' })
          : JSON.stringify(payload),
      signal: AbortSignal.timeout(
        artifact || action === 'commit-files' ? 5 * 60_000 : REQUEST_TIMEOUT,
      ),
      redirect: 'error',
      ...(artifact ? { duplex: 'half' as const } : {}),
    };
    const response = await fetch(
      new URL(`api/agents/${action}`, `${controller.href.replace(/\/$/, '')}/`),
      init,
    );
    const text = await boundedResponse(response, 256 * 1024);
    let data: Record<string, unknown>;
    try {
      data = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    } catch {
      throw new Error(`Controller returned invalid JSON (${response.status})`);
    }
    if (!response.ok)
      throw Object.assign(
        new Error(
          typeof data.error === 'string'
            ? data.error
            : `Controller rejected request (${response.status})`,
        ),
        { status: response.status, code: data.code },
      );
    return data;
  }

  async function saveSpool(
    directory: string,
    value: z.infer<typeof Spool>,
  ): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.delivery-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'delivery.json'));
  }

  async function deliver(directory: string): Promise<void> {
    const pending = Spool.parse(
      JSON.parse(await readFile(path.join(directory, 'delivery.json'), 'utf8')),
    );
    if (pending.blocked || (pending.nextAttemptAt ?? 0) > Date.now()) return;
    try {
      await performDelivery(directory, pending);
    } catch (error) {
      pending.deliveryAttempts = (pending.deliveryAttempts ?? 0) + 1;
      pending.lastError = (error as Error).message.slice(0, 2048);
      pending.nextAttemptAt =
        Date.now() +
        Math.min(300_000, 1000 * 2 ** Math.min(pending.deliveryAttempts, 8));
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'superseded'
      )
        pending.blocked = true;
      await saveSpool(directory, pending);
      throw error;
    }
  }

  async function performDelivery(
    directory: string,
    pending: z.infer<typeof Spool>,
  ): Promise<void> {
    const resumed = await request('resume', {
      sessionId,
      attemptId: pending.attemptId,
      leaseToken: pending.leaseToken,
      executionState: pending.executionState,
      coreTestId: pending.coreTestId,
    });
    if (resumed.receipt && typeof resumed.receipt === 'object') {
      const receipt = z
        .object({
          resultId: z.string(),
          stored: z.literal(true),
          checksum: z.string(),
        })
        .parse(resumed.receipt);
      const expected = pending.files
        ? createHash('sha256')
            .update(
              JSON.stringify(
                Object.keys(pending.files)
                  .sort()
                  .map(filename => [
                    filename,
                    pending.files![filename].size,
                    pending.files![filename].sha256,
                  ]),
              ),
            )
            .digest('hex')
        : (pending.archiveChecksum ??
          createHash('sha256')
            .update(await readFile(path.join(directory, 'result.zip')))
            .digest('hex'));
      if (
        receipt.resultId !== pending.resultId ||
        receipt.checksum !== expected
      )
        throw new Error(
          'Recovered receipt does not match the retained capture',
        );
      await rm(directory, { recursive: true, force: true });
      return;
    }
    pending.leaseToken = Id.parse(resumed.leaseToken);
    await saveSpool(directory, pending);
    let heartbeatError: Error | undefined;
    let sequence = 0;
    const timer = setInterval(() => {
      void request(
        'heartbeat',
        { sequence: ++sequence, executionState: pending.executionState },
        pending,
      ).catch(error => {
        heartbeatError = error as Error;
      });
    }, 15_000);
    try {
      let delivered: Record<string, unknown>;
      let checksum: string;
      if (pending.files && pending.capturePath) {
        const root = path.resolve(directory, pending.capturePath);
        if (!root.startsWith(`${directory}${path.sep}`))
          throw new Error('Invalid spool capture path');
        const begin = await request(
          'begin-files',
          {
            files: pending.files,
            coreTestId: pending.coreTestId,
            executionState: pending.executionState,
          },
          pending,
        );
        checksum = z.string().parse(begin.checksum);
        if (begin.stored) delivered = { receipt: begin };
        else {
          const transferId = z.string().parse(begin.transferId);
          const limits = z
            .object({
              maxFileBytes: z.number().positive(),
              maxTotalBytes: z.number().positive(),
              maxFiles: z.number().int().positive(),
            })
            .parse(begin.limits);
          const entries = Object.entries(pending.files);
          if (
            entries.length > limits.maxFiles ||
            entries.reduce((sum, [, descriptor]) => sum + descriptor.size, 0) >
              limits.maxTotalBytes
          )
            throw new Error(
              'Capture exceeds controller file-count or total-size limit; retained in spool',
            );
          pending.transferChecksum = checksum;
          await saveSpool(directory, pending);
          for (const [filename, descriptor] of entries) {
            if (descriptor.size > limits.maxFileBytes)
              throw new Error(
                `Artifact ${filename} exceeds the controller per-file limit; retained in spool`,
              );
            if (!safeArtifact(filename))
              throw new Error('Invalid artifact path in retained spool');
            const file = path.resolve(root, filename);
            if (!file.startsWith(`${root}${path.sep}`))
              throw new Error('Artifact escapes capture directory');
            if (
              (await stat(file)).size !== descriptor.size ||
              (await fileHash(file)) !== descriptor.sha256
            )
              throw new Error(`Retained artifact changed: ${filename}`);
            await request('upload-file', null, pending, undefined, {
              path: file,
              size: descriptor.size,
              filename,
              transferId,
            });
          }
          delivered = await request('commit-files', { transferId }, pending);
        }
      } else {
        const archivePath = path.join(directory, 'result.zip');
        if ((await stat(archivePath)).size > maximumArchiveBytes)
          throw new Error(
            `Legacy spool archive exceeds controller ZIP transfer limit (${Math.floor(maximumArchiveBytes / 1024 / 1024)} MiB)`,
          );
        const archive = await readFile(archivePath);
        checksum = createHash('sha256').update(archive).digest('hex');
        if (pending.archiveChecksum && pending.archiveChecksum !== checksum)
          throw new Error('Spool archive checksum mismatch');
        delivered = await request('upload', null, pending, archive);
      }
      const receipt = z
        .object({
          resultId: z.string(),
          stored: z.literal(true),
          checksum: z.string(),
          resultUrl: z.string().optional(),
        })
        .parse(delivered.receipt);
      if (
        receipt.resultId !== pending.resultId ||
        receipt.checksum !== checksum
      )
        throw new Error(
          'Controller receipt does not match the retained archive',
        );
      if (heartbeatError)
        console.warn(`Agent delivery heartbeat: ${heartbeatError.message}`);
      const resultUrl = new URL(
        receipt.resultUrl ?? `results/${receipt.resultId}`,
        `${controller.href.replace(/\/$/, '')}/`,
      );
      if (resultUrl.origin !== controller.origin)
        throw new Error('Controller result URL must use its configured origin');
      console.log(`Saved remote result: ${resultUrl.href}`);
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      await request(
        'event',
        {
          sequence: ++sequence,
          executionState: pending.executionState,
          deliveryError: (error as Error).message.slice(0, 2048),
        },
        pending,
      ).catch(() => {});
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  async function execute(claim: z.infer<typeof Claim>): Promise<void> {
    const url = new URL(claim.options.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !hostAllowed(url.hostname, allowHosts)
    ) {
      await request(
        'event',
        {
          sequence: 1,
          executionState: 'failed',
          error: 'Target host is outside the agent allowlist',
          noArtifacts: true,
        },
        claim,
      );
      return;
    }
    const directory = path.join(spoolDir, claim.attemptId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, 'claim.json'),
      JSON.stringify({
        jobId: claim.id,
        attemptId: claim.attemptId,
        leaseToken: claim.leaseToken,
        resultId: claim.resultId,
        executionState: 'interrupted',
      }),
      { mode: 0o600 },
    );
    let runOptions: LaunchOptions;
    try {
      const { scriptId, scriptHash, ...transport } = claim.options;
      runOptions = normalizeCLIConfig(transport as CLIOptions);
      if (typeof scriptId === 'string') {
        if (typeof scriptHash !== 'string')
          throw new Error('A script version hash is required');
        const script = await resolveTrustedScript(scriptId, scriptHash);
        runOptions.script = script.path;
        runOptions.scriptTimeout = Math.min(
          runOptions.scriptTimeout ?? 600_000,
          900_000,
        );
      }
      runOptions = {
        ...runOptions,
        headless: true,
        resultsDir: path.join(directory, 'captures'),
        allowedHosts: allowHosts,
        html: true,
        zip: false,
        openHtml: false,
        list: false,
        uploadUrl: null,
      };
    } catch (error) {
      await request(
        'event',
        {
          sequence: 1,
          executionState: 'failed',
          error: (error as Error).message,
          noArtifacts: true,
        },
        claim,
      );
      await rm(directory, { recursive: true, force: true });
      return;
    }
    let sequence = 0;
    let leaseUntil = claim.leaseUntil;
    let cancelled = false;
    let events = Promise.resolve();
    const event = (payload: Record<string, unknown>): Promise<void> => {
      const order = ++sequence;
      const next = events.then(async () => {
        const result = await request(
          'event',
          { ...payload, sequence: order },
          claim,
        );
        leaseUntil = z.number().parse(result.leaseUntil);
        if (result.cancelRequested) {
          cancelled = true;
          if (activeChild?.connected) activeChild.send({ type: 'cancel' });
        }
      });
      events = next.catch(error => {
        console.warn(`Agent progress delivery: ${(error as Error).message}`);
      });
      return next;
    };
    const child = fork(
      fileURLToPath(new URL('./runWorker.js', import.meta.url)),
      [`--telescope-attempt=${claim.attemptId}`],
      {
        detached: process.platform !== 'win32',
        env: { ...process.env, HEADLESS: 'true' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    );
    await writeFile(
      path.join(directory, 'claim.json'),
      JSON.stringify({
        jobId: claim.id,
        attemptId: claim.attemptId,
        leaseToken: claim.leaseToken,
        resultId: claim.resultId,
        executionState: 'interrupted',
        workerPid: child.pid,
      }),
      { mode: 0o600 },
    );
    activeChild = child;
    const deadline =
      Date.now() +
      (runOptions.script
        ? (runOptions.scriptTimeout ?? 600_000)
        : Math.min(claim.options.timeout ?? DEFAULT_OPTIONS.timeout, 300_000)) +
      90_000;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      cancelled = true;
      if (child.connected) child.send({ type: 'cancel' });
      forceTimer ??= setTimeout(() => killChild(child.pid), 15_000);
    };
    const timer = setInterval(() => {
      if (stopping || Date.now() > leaseUntil || Date.now() > deadline)
        cancel();
      else void event({ executionState: 'running' }).catch(() => {});
    }, 10_000);
    let result: TestResult;
    let lastProgress: RunProgress | undefined;
    let workerExited = false;
    try {
      result = await new Promise<TestResult>(resolve => {
        let settled = false;
        const finish = (value: TestResult) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        child.on('message', (message: unknown) => {
          if (!message || typeof message !== 'object') return;
          if (
            'type' in message &&
            message.type === 'progress' &&
            'progress' in message
          ) {
            const progress = message.progress as RunProgress;
            lastProgress = progress;
            void event({
              executionState:
                progress.phase === 'finalizing' ? 'finalizing' : 'running',
              coreTestId: progress.testId,
              progress,
            }).catch(() => {});
          }
          if (
            'type' in message &&
            message.type === 'result' &&
            'result' in message
          )
            finish(message.result as TestResult);
        });
        child.once('error', error =>
          finish({ success: false, error: error.message }),
        );
        child.once('exit', code => {
          if (!settled) workerExited = true;
          finish({
            success: false,
            error: `Agent worker exited before finalizing (${code})`,
          });
        });
        child.send({ type: 'run', options: runOptions });
      });
    } finally {
      clearInterval(timer);
      if (forceTimer) clearTimeout(forceTimer);
      activeChild = undefined;
      await events;
    }
    if (!result.success && !result.resultsPath && lastProgress)
      result = {
        ...result,
        resultsPath: lastProgress.resultsPath,
        testId: lastProgress.testId,
      };
    const resultPath = result.resultsPath;
    const fallbackState = cancelled
      ? 'cancelled'
      : result.success
        ? 'passed'
        : workerExited
          ? 'interrupted'
          : 'failed';
    const executionState =
      resultPath && result.testId
        ? await finalizeAbandonedCapture(
            resultPath,
            result.testId,
            fallbackState,
          )
        : fallbackState;
    if (!resultPath || !existsSync(path.join(resultPath, 'config.json'))) {
      await event({
        executionState,
        error: result.success ? undefined : result.error,
        noArtifacts: true,
      }).catch(() => {});
      await rm(directory, { recursive: true, force: true });
      return;
    }
    await writeFile(
      path.join(directory, 'claim.json'),
      JSON.stringify({
        jobId: claim.id,
        attemptId: claim.attemptId,
        leaseToken: claim.leaseToken,
        resultId: claim.resultId,
        executionState,
        coreTestId: result.testId,
        error: result.success ? undefined : result.error,
      }),
      { mode: 0o600 },
    );
    await event({
      executionState,
      coreTestId: result.testId,
      error: result.success ? undefined : result.error,
    }).catch(() => {});
    const files = await describeCapture(resultPath);
    await saveSpool(directory, {
      jobId: claim.id,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      resultId: claim.resultId,
      executionState,
      coreTestId: result.testId,
      error: result.success ? undefined : result.error,
      files,
      capturePath: path.relative(directory, resultPath),
    });
    await deliver(directory);
  }

  try {
    const browsers = installedBrowsers();
    const registration = await request('register', {
      sessionId,
      protocolVersion: PROTOCOL,
      capabilities: {
        browsers,
        browserVersions: await installedBrowserVersions(browsers),
        devices: Object.keys(playwright.devices),
        deviceBrowsers: Object.fromEntries(
          Object.entries(playwright.devices).map(([name, descriptor]) => [
            name,
            descriptor.defaultBrowserType === 'webkit'
              ? 'safari'
              : descriptor.defaultBrowserType === 'firefox'
                ? 'firefox'
                : 'chrome',
          ]),
        ),
        platform: process.platform,
        architecture: process.arch,
        version: getPackageVersion(),
        allowHosts,
        capacity: 1,
        fileTransfer: true,
        throttling:
          process.platform === 'linux' && existsSync('/sys/module/ifb'),
        scripts: await listTrustedScripts(),
      },
    });
    maximumArchiveBytes = z
      .number()
      .int()
      .positive()
      .max(MAX_ARCHIVE)
      .parse(registration.maximumArchiveBytes);
    console.log(`Telescope agent connected to ${controller.origin}`);
    while (!stopping) {
      try {
        await request('ping', { sessionId });
        const directories = (
          await readdir(spoolDir, { withFileTypes: true })
        ).filter(
          entry => entry.isDirectory() && Id.safeParse(entry.name).success,
        );
        let pending = false;
        for (const entry of directories) {
          const directory = path.join(spoolDir, entry.name);
          if (existsSync(path.join(directory, 'delivery.json'))) {
            const delivery = Spool.parse(
              JSON.parse(
                await readFile(path.join(directory, 'delivery.json'), 'utf8'),
              ),
            );
            if (!delivery.blocked) {
              pending = true;
              await deliver(directory);
            }
          } else if (existsSync(path.join(directory, 'claim.json'))) {
            pending = true;
            const abandoned = Spool.parse(
              JSON.parse(
                await readFile(path.join(directory, 'claim.json'), 'utf8'),
              ),
            );
            await stopAbandonedWorker(abandoned.workerPid, abandoned.attemptId);
            const capturesPath = path.join(directory, 'captures');
            const captures = existsSync(capturesPath)
              ? await readdir(capturesPath, { withFileTypes: true })
              : [];
            const capture = captures.find(
              item =>
                item.isDirectory() &&
                existsSync(path.join(capturesPath, item.name, 'config.json')),
            );
            if (capture) {
              const capturePath = path.join(capturesPath, capture.name);
              const executionState = await finalizeAbandonedCapture(
                capturePath,
                capture.name,
              );
              await saveSpool(directory, {
                ...abandoned,
                executionState,
                coreTestId: capture.name,
                files: await describeCapture(capturePath),
                capturePath: path.relative(directory, capturePath),
              });
              await deliver(directory);
            } else {
              const resumed = await request('resume', {
                ...abandoned,
                sessionId,
              });
              if (!resumed.receipt)
                await request(
                  'event',
                  {
                    sequence: 1,
                    executionState: 'interrupted',
                    noArtifacts: true,
                    error: 'Agent restarted before capture was available',
                  },
                  { ...abandoned, leaseToken: Id.parse(resumed.leaseToken) },
                );
              await rm(directory, { recursive: true, force: true });
            }
          }
        }
        if (
          !pending &&
          (await directoryBytes(spoolDir, 2 * 1024 * 1024 * 1024)) <
            2 * 1024 * 1024 * 1024
        ) {
          const reply = await request('claim', { sessionId });
          if (reply.job) await execute(Claim.parse(reply.job));
        }
      } catch (error) {
        console.error(`Agent: ${(error as Error).message}`);
      }
      if (!stopping)
        await delay(
          Math.max(options.pollInterval ?? 5000, 1000),
          options.signal,
        );
    }
  } finally {
    stop();
    options.signal?.removeEventListener('abort', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function hostAllowed(hostname: string, hosts: string[]): boolean {
  const normalized = hostname.toLowerCase();
  return hosts.some(host =>
    host.startsWith('*.')
      ? normalized.endsWith(host.slice(1)) && normalized !== host.slice(2)
      : host === normalized,
  );
}

async function directoryBytes(root: string, maximum: number): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(root, entry.name);
    total += entry.isDirectory()
      ? await directoryBytes(filename, maximum - total)
      : (await stat(filename)).size;
    if (total >= maximum) break;
  }
  return total;
}

async function stopAbandonedWorker(
  pid: number | undefined,
  attemptId: string,
): Promise<void> {
  if (!pid || process.platform === 'win32') return;
  let command = '';
  try {
    if (process.platform === 'linux')
      command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll(
        '\0',
        ' ',
      );
    else
      command = await new Promise<string>((resolve, reject) => {
        execFile(
          '/bin/ps',
          ['-p', String(pid), '-o', 'command='],
          { encoding: 'utf8', timeout: 3000, maxBuffer: 65_536 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
  } catch {
    return;
  }
  // A reused PID must never cause another application's process group to die.
  if (
    command.includes('runWorker.js') &&
    command.includes(`--telescope-attempt=${attemptId}`)
  )
    killChild(pid);
}

async function finalizeAbandonedCapture(
  root: string,
  testId: string,
  outcome: z.infer<typeof Spool>['executionState'] = 'interrupted',
): Promise<z.infer<typeof Spool>['executionState']> {
  let previous: Record<string, unknown> = {};
  try {
    previous = z
      .record(z.string(), z.unknown())
      .parse(
        JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8')),
      );
  } catch {
    /* Write a recoverable partial manifest. */
  }
  const terminal = z
    .enum(['passed', 'failed', 'cancelled', 'interrupted'])
    .safeParse(previous.status);
  let changedScenario = false;
  const scenarioPath = path.join(root, 'scenario.json');
  if (existsSync(scenarioPath)) {
    const scenario = ScenarioManifestSchema.parse(
      JSON.parse(await readFile(scenarioPath, 'utf8')),
    );
    if (scenario.status === 'running') {
      changedScenario = true;
      outcome =
        terminal.success && terminal.data !== 'passed'
          ? terminal.data
          : outcome === 'passed'
            ? 'interrupted'
            : outcome;
      scenario.status = outcome;
      scenario.finishedAt = new Date().toISOString();
      scenario.error = 'Agent stopped before journey finalization';
      for (const step of scenario.steps) {
        if (step.status === 'pending') step.status = 'skipped';
        else if (step.status === 'running') {
          step.status = outcome === 'cancelled' ? 'cancelled' : 'failed';
          step.error = scenario.error;
          step.artifacts = undefined;
        }
      }
      const temporary = `${scenarioPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(scenario), { mode: 0o600 });
      await rename(temporary, scenarioPath);
    }
  }
  if (terminal.success && !changedScenario) return terminal.data;
  const files = await describeCapture(root);
  delete files['result.json'];
  const started =
    typeof previous.startedAt === 'string' &&
    Number.isFinite(new Date(previous.startedAt).getTime())
      ? new Date(previous.startedAt).toISOString()
      : new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    testId,
    status: outcome,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    error: 'Agent stopped before capture finalization',
    artifacts: files,
  };
  const temporary = path.join(root, `.result-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
  await rename(temporary, path.join(root, 'result.json'));
  return outcome;
}

function safeArtifact(filename: string): boolean {
  if (
    filename.includes('\\') ||
    filename.includes(':') ||
    filename.split('/').some(part => !part || part === '.' || part === '..')
  )
    return false;
  if (
    /^(config|result|identity|scenario|metrics|resources|console)\.json$/.test(
      filename,
    )
  )
    return true;
  if (
    /^(pageload\.har|screenshot\.png|engine\.png|index\.html)$/.test(filename)
  )
    return true;
  if (/^[a-zA-Z0-9_.-]+\.webm$/.test(filename)) return true;
  if (/^filmstrip\/[a-zA-Z0-9_.-]+\.(jpg|png)$/.test(filename)) return true;
  if (/^baseline\/[a-zA-Z0-9_./-]+\.json$/.test(filename)) return true;
  return /^steps\/\d{4}\/(metrics\.json|resources\.json|console\.json|pageload\.har|screenshot\.png|index\.html|filmstrip\/[a-zA-Z0-9_.-]+\.(jpg|png))$/.test(
    filename,
  );
}

async function fileHash(filename: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

async function describeCapture(
  root: string,
): Promise<Record<string, { size: number; sha256: string }>> {
  const files: Record<string, { size: number; sha256: string }> = {};
  let total = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Capture contains a symlink');
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const relative = path
          .relative(root, filename)
          .split(path.sep)
          .join('/');
        if (!safeArtifact(relative)) continue;
        const size = (await stat(filename)).size;
        total += size;
        if (
          Object.keys(files).length >= 10_000 ||
          total > 2 * 1024 * 1024 * 1024
        )
          throw new Error('Capture exceeds agent spool delivery limits');
        files[relative] = { size, sha256: await fileHash(filename) };
      }
    }
  }
  await visit(root);
  return files;
}

function installedBrowsers(): string[] {
  const browsers: string[] = [];
  if (existsSync(playwright.chromium.executablePath()))
    browsers.push('chromium');
  if (existsSync(playwright.firefox.executablePath())) browsers.push('firefox');
  if (existsSync(playwright.webkit.executablePath())) browsers.push('safari');
  const branded: Record<string, string[]> = {
    chrome: [
      '/opt/google/chrome/chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
    'chrome-beta': [
      '/opt/google/chrome-beta/chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    ],
    edge: [
      '/opt/microsoft/msedge/msedge',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    canary: [
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ],
  };
  for (const [name, candidates] of Object.entries(branded))
    if (candidates.some(candidate => existsSync(candidate)))
      browsers.push(name);
  return browsers;
}

async function installedBrowserVersions(
  browsers: string[],
): Promise<Record<string, string>> {
  const candidates: Record<string, string[]> = {
    chromium: [playwright.chromium.executablePath()],
    firefox: [playwright.firefox.executablePath()],
    chrome: [
      '/opt/google/chrome/chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
    'chrome-beta': [
      '/opt/google/chrome-beta/chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    ],
    edge: [
      '/opt/microsoft/msedge/msedge',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    canary: [
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ],
  };
  const versions: Record<string, string> = {};
  for (const browser of browsers) {
    const executable = candidates[browser]?.find(filename =>
      existsSync(filename),
    );
    versions[browser] = executable
      ? await new Promise<string>(resolve => {
          execFile(
            executable,
            ['--version'],
            { encoding: 'utf8', timeout: 3000, maxBuffer: 65_536 },
            (error, stdout, stderr) => {
              const match = `${stdout} ${stderr}`.match(
                /\d+\.\d+(?:\.\d+){0,3}/,
              );
              resolve(!error && match ? match[0] : 'unknown until capture');
            },
          );
        })
      : 'unknown until capture';
  }
  return versions;
}

function killChild(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch {
    /* Already exited. */
  }
}

async function boundedResponse(
  response: Response,
  limit: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Controller response exceeds limit');
      }
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
  });
}
