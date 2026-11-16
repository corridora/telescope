import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import AdmZip from 'adm-zip';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LocalStore } from '../src/localStore.js';
import { parseLocalOptions } from '../src/localOptions.js';
import type { ChildProcess } from 'node:child_process';
import type {
  ResultManifest,
  ScenarioManifest,
  ScenarioStepResult,
} from '../src/types.js';

const TEST_DATE = '2026-11-16T12:00:00.000Z';
const TARGET = 'http://localhost:3000/';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X8AAAAASUVORK5CYII=',
  'base64',
);
const stores = new Set<LocalStore>();
const temporaryDirectories = new Set<string>();

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'telescope-local-workspace-'),
  );
  temporaryDirectories.add(directory);
  return directory;
}

function openStore(directory = temporaryDirectory()): LocalStore {
  const store = new LocalStore(directory);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function descriptor(bytes: Buffer): { size: number; sha256: string } {
  return {
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function zipBytes(files: Record<string, Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [filename, bytes] of Object.entries(files))
    zip.addFile(filename, bytes);
  return zip.toBuffer();
}

function captureFiles(): Record<string, Buffer> {
  return {
    'config.json': jsonBytes({
      url: TARGET,
      date: TEST_DATE,
      options: { url: TARGET, browser: 'firefox', frameRate: 1 },
      browserConfig: {
        engine: 'firefox',
        viewport: { width: 1280, height: 720 },
      },
    }),
    'metrics.json': jsonBytes({
      navigationTiming: {
        name: TARGET,
        duration: 42,
        fetchStart: 1,
        responseStart: 5,
      },
      paintTiming: [],
      largestContentfulPaint: [],
      layoutShifts: [],
    }),
    'resources.json': jsonBytes([
      { name: `${TARGET}app.js`, transferSize: 11, duration: 7 },
    ]),
    'console.json': jsonBytes([
      {
        type: 'log',
        text: 'fixture ready',
        location: { url: TARGET, lineNumber: 1 },
      },
    ]),
    'pageload.har': jsonBytes({
      log: {
        browser: { name: 'Firefox', version: 'fixture' },
        pages: [{ id: 'page_1', pageTimings: {} }],
        entries: [],
      },
    }),
    'screenshot.png': PNG,
    'session.webm': Buffer.from('0123456789'),
  };
}

function captureFixture(
  options: {
    scenario?: boolean;
    changeScenario?: (scenario: ScenarioManifest) => void;
  } = {},
): { testId: string; files: Record<string, Buffer>; archive: Buffer } {
  const testId = `2026_11_16_12_00_00_${crypto.randomUUID()}`;
  const source = captureFiles();
  const files = { ...source };
  if (options.scenario) {
    delete files['metrics.json'];
    delete files['resources.json'];
    delete files['console.json'];
    const steps: ScenarioStepResult[] = ['0001', '0002'].map((id, order) => {
      const artifactBase = `steps/${id}`;
      const stepFiles: Record<string, Buffer> = {
        'metrics.json':
          order === 0
            ? source['metrics.json']
            : jsonBytes({
                scope: 'interval',
                userTiming: [],
                layoutShifts: [],
              }),
        'resources.json': source['resources.json'],
        'console.json': source['console.json'],
        'pageload.har': source['pageload.har'],
        'screenshot.png': source['screenshot.png'],
        'recording.webm': source['session.webm'],
        'filmstrip/frame_0.png': PNG,
      };
      for (const [filename, bytes] of Object.entries(stepFiles))
        files[`${artifactBase}/${filename}`] = bytes;
      return {
        id,
        order,
        name: order === 0 ? 'Open page' : 'Interact',
        kind: order === 0 ? 'navigation' : 'interaction',
        status: 'passed',
        artifactBase,
        metricScope: order === 0 ? 'navigation' : 'interval',
        startOffsetMs: order * 100,
        durationMs: 100,
        artifacts: Object.fromEntries(
          Object.entries(stepFiles).map(([filename, bytes]) => [
            filename,
            descriptor(bytes),
          ]),
        ),
        media: {
          status: 'available',
          videoPath: `${artifactBase}/recording.webm`,
          frameRate: 1,
          frames: [{ path: `${artifactBase}/filmstrip/frame_0.png`, ms: 0 }],
          alignment: {
            method: 'color-calibration',
            uncertaintyMs: 50,
            videoStartMs: order * 100,
          },
        },
      };
    });
    const scenario: ScenarioManifest = {
      schemaVersion: 1,
      status: 'passed',
      startedAt: TEST_DATE,
      finishedAt: TEST_DATE,
      durationMs: 200,
      video: { path: 'session.webm', startOffsetMs: 0 },
      steps,
    };
    options.changeScenario?.(scenario);
    files['scenario.json'] = jsonBytes(scenario);
  }
  const manifest: ResultManifest = {
    schemaVersion: 1,
    testId,
    status: 'passed',
    startedAt: TEST_DATE,
    finishedAt: TEST_DATE,
    artifacts: Object.fromEntries(
      Object.entries(files).map(([filename, bytes]) => [
        filename,
        descriptor(bytes),
      ]),
    ),
  };
  files['result.json'] = jsonBytes(manifest);
  return { testId, files, archive: zipBytes(files) };
}

async function exportedBytes(
  store: LocalStore,
  testId: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of store.exportResult(testId))
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of temporaryDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('Persistent local workspace without browser execution', () => {
  it('excludes a second writer and releases the workspace on a clean restart', () => {
    const directory = temporaryDirectory();
    const first = openStore(directory);
    expect(() => new LocalStore(directory)).toThrow(/already in use/);
    closeStore(first);
    const restarted = openStore(directory);
    expect(restarted.root).toBe(fs.realpathSync(directory));
    expect(restarted.results()).toEqual([]);
  });

  it('retains definitions, device emulation, and edits across restart without retaining reusable secrets', () => {
    const directory = temporaryDirectory();
    const store = openStore(directory);
    const options = parseLocalOptions({
      url: 'http://user:password@localhost:3000/?token=private&view=summary',
      device: 'iPhone 13',
      auth: { username: 'user', password: 'private' },
      cookies: [{ name: 'session', value: 'private', url: TARGET }],
      headers: {
        Authorization: 'Bearer private',
        'x-api-key': 'private',
        'x-environment': 'development',
      },
    });
    const definition = store.saveDefinition({
      name: 'Homepage',
      description: 'Reusable check',
      options,
    });
    expect(definition.options.auth).toBeUndefined();
    expect(definition.options.cookies).toBeUndefined();
    expect(definition.options.headers).toEqual({
      'x-environment': 'development',
    });
    expect(new URL(definition.options.url).username).toBe('');
    expect(new URL(definition.options.url).searchParams.has('token')).toBe(
      false,
    );
    expect(definition.options.deviceName).toBe('iPhone 13');
    expect(definition.options.device?.hasTouch).toBe(true);
    store.saveDefinition(
      { name: 'Renamed homepage', options: definition.options },
      definition.id,
    );
    closeStore(store);
    const restarted = openStore(directory);
    expect(restarted.definitions()).toHaveLength(1);
    expect(restarted.definitions()[0]).toMatchObject({
      id: definition.id,
      name: 'Renamed homepage',
      options: { deviceName: 'iPhone 13', device: { hasTouch: true } },
    });
  });

  it('marks abandoned jobs interrupted on restart and preserves idempotent submission identity', () => {
    const directory = temporaryDirectory();
    const store = openStore(directory);
    const options = parseLocalOptions({ url: TARGET, browser: 'firefox' });
    const first = store.createJob(options, 'first-request');
    expect(store.createJob(options, 'first-request').id).toBe(first.id);
    expect(() =>
      store.createJob(
        { ...options, url: `${TARGET}different` },
        'first-request',
      ),
    ).toThrow(/different options/);
    first.status = 'running';
    store.saveJob(first);
    const queued = store.createJob(options, 'queued-request');
    closeStore(store);
    const restarted = openStore(directory);
    expect(restarted.job(first.id)).toMatchObject({
      status: 'interrupted',
      options: { url: TARGET },
    });
    expect(restarted.job(queued.id)).toMatchObject({ status: 'interrupted' });
    expect(restarted.job(first.id)?.error).toMatch(/Rerun explicitly/);
  });

  it('assigns a portable identity to a legacy ZIP and preserves it through streamed export/import', async () => {
    const source = openStore();
    const legacyFiles = captureFiles();
    const archive = zipBytes(legacyFiles);
    const imported = source.importResult(archive);
    expect(source.resultSummary(imported.testId)?.status).toBe('legacy');
    expect(source.importResult(archive)).toEqual({
      testId: imported.testId,
      duplicate: true,
    });
    const exported = await exportedBytes(source, imported.testId);
    const zip = new AdmZip(exported);
    expect(JSON.parse(zip.readAsText('identity.json'))).toEqual({
      schemaVersion: 1,
      testId: imported.testId,
    });
    expect(zip.readFile('config.json')).toEqual(legacyFiles['config.json']);
    const destination = openStore();
    expect(destination.importResult(exported)).toEqual({
      testId: imported.testId,
      duplicate: false,
    });
    expect(destination.resultSummary(imported.testId)?.status).toBe('legacy');
  });

  it('round trips a committed capture with unchanged files and canonical identity', async () => {
    const fixture = captureFixture();
    const source = openStore();
    expect(source.importResult(fixture.archive)).toEqual({
      testId: fixture.testId,
      duplicate: false,
    });
    expect(source.resultSummary(fixture.testId)?.status).toBe('passed');
    const destination = openStore();
    const exported = await exportedBytes(source, fixture.testId);
    expect(destination.importResult(exported)).toEqual({
      testId: fixture.testId,
      duplicate: false,
    });
    for (const [filename, bytes] of Object.entries(fixture.files))
      expect(
        fs.readFileSync(destination.artifact(fixture.testId, filename)),
      ).toEqual(bytes);
    expect(destination.importResult(exported)).toEqual({
      testId: fixture.testId,
      duplicate: true,
    });
  });

  it('imports step-scoped captures without requiring fabricated root navigation metrics', () => {
    const fixture = captureFixture({ scenario: true });
    const store = openStore();
    expect(store.importResult(fixture.archive).testId).toBe(fixture.testId);
    expect(
      fs.existsSync(path.join(store.root, fixture.testId, 'metrics.json')),
    ).toBe(false);
    const result = store.result(fixture.testId, '0002');
    expect(result).toMatchObject({
      selectedStep: {
        id: '0002',
        kind: 'interaction',
        media: { status: 'available', videoPath: 'steps/0002/recording.webm' },
      },
      metrics: { scope: 'interval' },
    });
    const artifacts = result.artifacts as Array<{ path: string }>;
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.every(item => item.path.startsWith('steps/0002/'))).toBe(
      true,
    );
  });

  it.each([
    'cross-step video',
    'out-of-interval frame',
    'corrupt scoped descriptor',
  ] as const)('rejects %s without publishing the capture', corruption => {
    const fixture = captureFixture({
      scenario: true,
      changeScenario: scenario => {
        const step = scenario.steps[0];
        if (corruption === 'cross-step video')
          step.media!.videoPath = 'steps/0002/recording.webm';
        else if (corruption === 'out-of-interval frame')
          step.media!.frames![0].ms = step.durationMs! + 1;
        else step.artifacts!['recording.webm'].sha256 = '0'.repeat(64);
      },
    });
    const store = openStore();
    expect(() => store.importResult(fixture.archive)).toThrow(
      /media|integrity/i,
    );
    expect(store.resultSummary(fixture.testId)).toBeNull();
    expect(fs.existsSync(path.join(store.root, fixture.testId))).toBe(false);
  });

  it('rejects capture-level checksum corruption rather than publishing a passed result', () => {
    const fixture = captureFixture();
    fixture.files['resources.json'] = jsonBytes([
      { name: 'changed after capture' },
    ]);
    const store = openStore();
    expect(() => store.importResult(zipBytes(fixture.files))).toThrow(
      /integrity/i,
    );
    expect(store.results()).toEqual([]);
  });

  it('blocks artifact reads through symlinks outside the selected capture', () => {
    const fixture = captureFixture();
    const store = openStore();
    store.importResult(fixture.archive);
    const outside = path.join(temporaryDirectory(), 'outside.json');
    fs.writeFileSync(outside, 'private');
    fs.symlinkSync(
      outside,
      path.join(store.root, fixture.testId, 'outside.json'),
    );
    expect(() => store.artifact(fixture.testId, 'outside.json')).toThrow(
      /outside/,
    );
    expect(
      store
        .artifacts(fixture.testId)
        .some(item => item.path === 'outside.json'),
    ).toBe(false);
  });
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No local test port was allocated');
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stopService(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

describe('Local HTTP workspace without browser execution', () => {
  let child: ChildProcess | undefined;
  let directory: string;
  let base: string;
  let fixture: ReturnType<typeof captureFixture>;
  let cookie: string;
  const token = crypto.randomBytes(32).toString('hex');
  const headers = { 'X-Telescope-Token': token };

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telescope-local-http-'));
    const resultsDir = path.join(directory, 'saved results');
    const store = new LocalStore(resultsDir);
    try {
      fixture = captureFixture();
      store.importResult(fixture.archive);
    } finally {
      store.close();
    }
    const port = await availablePort();
    base = `http://127.0.0.1:${port}`;
    const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
    let output = '';
    child = spawn(
      process.execPath,
      [
        cli,
        'local',
        '--host',
        '0.0.0.0',
        '--port',
        String(port),
        '--resultsDir',
        resultsDir,
        '--no-open',
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          HEADLESS: 'true',
          RUNNING_IN_DOCKER: 'true',
          TELESCOPE_LOCAL_TOKEN: token,
          TELESCOPE_ALLOWED_HOSTS: '127.0.0.1,localhost',
          TELESCOPE_SCRIPTS_DIR: '',
          UPLOAD_FORWARD_URL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    });
    const deadline = Date.now() + 20_000;
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Local service stopped during startup: ${output}`);
      try {
        if (
          (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }))
            .ok
        )
          break;
      } catch {
        /* Wait only for the newly started HTTP listener. */
      }
      if (Date.now() >= deadline)
        throw new Error(`Local service did not become ready: ${output}`);
      await delay(50);
    }
    const session = await fetch(`${base}/api/local/session`, { headers });
    expect(session.status).toBe(200);
    cookie = session.headers.get('set-cookie')!.split(';')[0];
  }, 30_000);

  afterAll(async () => {
    await stopService(child);
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }, 15_000);

  it('requires the entry token on a non-loopback listener and keeps it out of public HTML', async () => {
    const session = await fetch(`${base}/api/local/session`);
    expect(session.status).toBe(401);
    expect(await session.json()).toMatchObject({ requiresToken: true });
    const unauthenticated = await fetch(`${base}/api/local/results`);
    expect(unauthenticated.status).toBe(401);
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(token);
  });

  it('rejects an unapproved Host even with a valid token', async () => {
    const status = await new Promise<number>(resolve => {
      const target = new URL(base);
      const request = http.get(
        {
          host: '127.0.0.1',
          port: target.port,
          path: '/api/local/results',
          headers: { ...headers, Host: 'untrusted.example' },
        },
        response => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', () => resolve(0));
    });
    expect(status).toBe(403);
  });

  it('rejects foreign Origin and cross-site fetch metadata despite a valid token', async () => {
    const origin = await fetch(`${base}/api/local/results`, {
      headers: { ...headers, Origin: 'https://untrusted.example' },
    });
    expect(origin.status).toBe(403);
    const crossSite = await fetch(`${base}/api/local/results`, {
      headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
  });

  it('allows cookie reads but requires a token header for a definition mutation', async () => {
    const reads = await fetch(`${base}/api/local/results`, {
      headers: { Cookie: cookie },
    });
    expect(reads.status).toBe(200);
    const body = JSON.stringify({
      name: 'HTTP saved definition',
      options: { url: TARGET, browser: 'firefox' },
    });
    const rejected = await fetch(`${base}/api/local/definitions`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: base,
      },
      body,
    });
    expect(rejected.status).toBe(403);
    const accepted = await fetch(`${base}/api/local/definitions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
      body,
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      definition: { name: 'HTTP saved definition', options: { url: TARGET } },
    });
  });

  it('serves committed diagnostics and artifacts from local storage with private cache headers', async () => {
    const result = await fetch(`${base}/api/local/results/${fixture.testId}`, {
      headers,
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      summary: { testId: fixture.testId, status: 'passed' },
      metrics: { navigationTiming: { duration: 42 } },
    });
    const artifact = await fetch(
      `${base}/api/local/artifacts/${fixture.testId}/resources.json`,
      { headers: { Cookie: cookie } },
    );
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('cache-control')).toBe('no-store');
    expect(artifact.headers.get('content-security-policy')).toContain(
      'sandbox',
    );
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(
      fixture.files['resources.json'],
    );
  });

  it('serves bounded video ranges and rejects a range outside the artifact', async () => {
    const video = await fetch(
      `${base}/api/local/artifacts/${fixture.testId}/session.webm`,
      { headers: { ...headers, Range: 'bytes=2-4' } },
    );
    expect(video.status).toBe(206);
    expect(video.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await video.text()).toBe('234');
    const invalid = await fetch(
      `${base}/api/local/artifacts/${fixture.testId}/session.webm`,
      { headers: { ...headers, Range: 'bytes=100-200' } },
    );
    expect(invalid.status).toBe(416);
  });

  it('streams a complete portable archive through the authenticated read-only route', async () => {
    const response = await fetch(
      `${base}/api/local/results/${fixture.testId}/export`,
      { headers },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    expect(zip.readFile('resources.json')).toEqual(
      fixture.files['resources.json'],
    );
    expect(JSON.parse(zip.readAsText('identity.json'))).toMatchObject({
      testId: fixture.testId,
    });
  });
});
