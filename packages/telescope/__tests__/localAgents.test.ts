import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateTestID } from '../src/helpers.js';
import { createLocalAgentController } from '../src/localAgentController.js';
import { LocalStore } from '../src/localStore.js';

const ORIGIN = 'http://127.0.0.1:4321';
const TARGET = 'https://app.internal/product';
const ADMIN = 'local-agent-test-admin';

interface Enrollment {
  id: string;
  token: string;
}
interface Executor extends Enrollment {
  sessionId: string;
}
interface Claim {
  id: string;
  attemptId: string;
  leaseToken: string;
  leaseUntil: number;
  resultId: string;
  options: Record<string, unknown>;
}
interface Receipt {
  resultId: string;
  coreTestId: string;
  stored: boolean;
  checksum: string;
  resultUrl: string;
}
interface JobStatus {
  job: {
    execution_state: string;
    delivery_state: string;
    cancel_requested: number;
  };
  attempts: Array<{
    execution_state: string;
    delivery_state: string;
    receipt?: Receipt;
  }>;
}

describe('Filesystem remote-agent execution protocol', () => {
  let directory: string;
  let store: LocalStore;
  let controller: ReturnType<typeof createLocalAgentController>;

  function open(): void {
    store = new LocalStore(directory);
    controller = createLocalAgentController({
      store,
      authorizeAdmin: request =>
        request.headers.get('authorization') === `Bearer ${ADMIN}`,
    });
  }

  async function call<T = Record<string, unknown>>(
    pathname: string,
    options: {
      method?: string;
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
      bytes?: Uint8Array;
    } = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${options.token ?? ADMIN}`);
    if (options.bytes) headers.set('content-type', 'application/octet-stream');
    else if (options.body !== undefined)
      headers.set('content-type', 'application/json');
    const response = await controller.handle(
      new Request(`${ORIGIN}${pathname}`, {
        method:
          options.method ??
          (options.body !== undefined || options.bytes ? 'POST' : 'GET'),
        headers,
        body: options.bytes
          ? new Uint8Array(options.bytes)
          : options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
      }),
    );
    expect(response).not.toBeNull();
    return {
      status: response!.status,
      body: (await response!.json()) as T,
      headers: response!.headers,
    };
  }

  async function enroll(name = 'Test runner'): Promise<Enrollment> {
    const response = await call<Enrollment>('/api/agents', { body: { name } });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function register(
    agent: Enrollment,
    sessionId = crypto.randomUUID(),
  ): Promise<Executor> {
    const response = await call('/api/agents/register', {
      token: agent.token,
      body: {
        protocolVersion: 1,
        sessionId,
        capabilities: {
          browsers: ['chromium'],
          platform: 'linux',
          architecture: 'x64',
          version: 'fixture',
          allowHosts: ['app.internal'],
        },
      },
    });
    expect(response.status).toBe(200);
    return { ...agent, sessionId };
  }

  async function submit(
    agent: Executor,
    key = crypto.randomUUID(),
    url = TARGET,
  ): Promise<string> {
    const response = await call<{ jobId: string }>('/api/runs', {
      body: {
        agentId: agent.id,
        name: 'Product capture',
        options: { url, browser: 'chromium', timeout: 1000 },
      },
      headers: { 'idempotency-key': key },
    });
    expect([200, 202]).toContain(response.status);
    return response.body.jobId;
  }

  async function claim(agent: Executor): Promise<Claim> {
    const response = await call<{ job: Claim }>('/api/agents/claim', {
      token: agent.token,
      body: { sessionId: agent.sessionId },
    });
    expect(response.status).toBe(200);
    expect(response.body.job).toBeTruthy();
    return response.body.job;
  }

  function leaseHeaders(
    agent: Executor,
    capture: Claim,
  ): Record<string, string> {
    return {
      'x-telescope-session': agent.sessionId,
      'x-telescope-attempt': capture.attemptId,
      'x-telescope-lease': capture.leaseToken,
    };
  }

  async function finish(
    agent: Executor,
    capture: Claim,
    coreTestId: string,
  ): Promise<void> {
    const response = await call('/api/agents/event', {
      token: agent.token,
      headers: leaseHeaders(agent, capture),
      body: { sequence: 1, executionState: 'passed', coreTestId },
    });
    expect(response.status).toBe(200);
  }

  function captureFiles(
    coreTestId: string,
    url = TARGET,
  ): Record<string, Uint8Array> {
    const encoded = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value));
    const files: Record<string, Uint8Array> = {
      'config.json': encoded({
        url,
        date: '2026-11-16T12:00:00.000Z',
        options: { url, browser: 'chromium' },
        browserConfig: { engine: 'chromium' },
      }),
      'metrics.json': encoded({
        navigationTiming: { name: url, duration: 42 },
        paintTiming: [],
        userTiming: [],
        largestContentfulPaint: [],
        layoutShifts: [],
      }),
      'resources.json': encoded([]),
      'console.json': encoded([
        {
          type: 'log',
          text: 'capture fixture',
          location: { url, lineNumber: 0, columnNumber: 0 },
        },
      ]),
      'pageload.har': encoded({
        log: {
          pages: [],
          entries: [],
          browser: { name: 'Chromium', version: 'fixture' },
        },
      }),
      'index.html': new TextEncoder().encode(
        '<!doctype html><title>Captured report</title>',
      ),
    };
    files['result.json'] = encoded({
      schemaVersion: 1,
      testId: coreTestId,
      status: 'passed',
      startedAt: '2026-11-16T12:00:00.000Z',
      finishedAt: '2026-11-16T12:00:01.000Z',
      artifacts: descriptors(files),
    });
    return files;
  }

  function descriptors(
    files: Record<string, Uint8Array>,
  ): Record<string, { size: number; sha256: string }> {
    return Object.fromEntries(
      Object.entries(files).map(([filename, value]) => [
        filename,
        {
          size: value.byteLength,
          sha256: crypto.createHash('sha256').update(value).digest('hex'),
        },
      ]),
    );
  }

  async function begin(
    agent: Executor,
    capture: Claim,
    coreTestId: string,
    files: Record<string, Uint8Array>,
  ): Promise<{ transferId: string; checksum: string }> {
    const response = await call<{ transferId: string; checksum: string }>(
      '/api/agents/begin-files',
      {
        token: agent.token,
        headers: leaseHeaders(agent, capture),
        body: {
          files: descriptors(files),
          coreTestId,
          executionState: 'passed',
        },
      },
    );
    expect(response.status).toBe(200);
    return response.body;
  }

  async function upload(
    agent: Executor,
    capture: Claim,
    transferId: string,
    filename: string,
    value: Uint8Array,
  ) {
    return call('/api/agents/upload-file', {
      token: agent.token,
      bytes: value,
      headers: {
        ...leaseHeaders(agent, capture),
        'x-telescope-transfer': transferId,
        'x-telescope-artifact': encodeURIComponent(filename),
        'content-length': String(value.byteLength),
      },
    });
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'telescope-agent-integration-'),
    );
    open();
  });

  afterEach(() => {
    controller.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('requires administrative enrollment and keeps credentials out of durable public metadata', async () => {
    expect(
      (
        await call('/api/agents', {
          body: { name: 'unauthorized' },
          token: 'invalid',
        })
      ).status,
    ).toBe(401);
    const enrolled = await enroll();
    await register(enrolled);
    const listing = await call<{ agents: Array<Record<string, unknown>> }>(
      '/api/agents',
    );
    expect(listing.body.agents).toHaveLength(1);
    expect(listing.body.agents[0]).toMatchObject({
      id: enrolled.id,
      status: 'active',
      online: true,
    });
    expect(JSON.stringify(listing.body)).not.toContain(enrolled.token);
    expect(
      fs.readFileSync(
        path.join(store.metadataRoot, 'remote', 'controller.json'),
        'utf8',
      ),
    ).not.toContain(enrolled.token);
    expect((await call('/api/runs', { token: enrolled.token })).status).toBe(
      401,
    );
  });

  it('deduplicates submissions and gives one concurrent claim ownership of the queued job', async () => {
    const agent = await register(await enroll());
    const key = crypto.randomUUID();
    const first = await submit(agent, key);
    expect(await submit(agent, key)).toBe(first);
    const replies = await Promise.all(
      [0, 1].map(() =>
        call<{ job: Claim | null }>('/api/agents/claim', {
          token: agent.token,
          body: { sessionId: agent.sessionId },
        }),
      ),
    );
    expect(replies.filter(reply => reply.body.job)).toHaveLength(1);
    expect(replies.find(reply => reply.body.job)?.body.job?.id).toBe(first);
    const status = await call<JobStatus>(`/api/runs/${first}`);
    expect(status.body.attempts).toHaveLength(1);
    const conflicting = await call('/api/runs', {
      body: {
        agentId: agent.id,
        options: { url: 'https://other.internal', browser: 'chromium' },
      },
      headers: { 'idempotency-key': key },
    });
    expect(conflicting.status).toBe(409);
  });

  it('delivers cancellation to the owner and fences old leases and other agents', async () => {
    const agent = await register(await enroll());
    const other = await register(await enroll('Other runner'));
    const jobId = await submit(agent);
    const assigned = await claim(agent);
    const denied = await call('/api/agents/event', {
      token: other.token,
      headers: leaseHeaders(other, assigned),
      body: { sequence: 1, executionState: 'passed' },
    });
    expect(denied.status).toBe(409);
    expect((await call(`/api/runs/${jobId}/cancel`, { body: {} })).status).toBe(
      200,
    );
    const heartbeat = await call<{ cancelRequested: boolean }>(
      '/api/agents/heartbeat',
      {
        token: agent.token,
        headers: leaseHeaders(agent, assigned),
        body: { sequence: 1, executionState: 'running' },
      },
    );
    expect(heartbeat.body.cancelRequested).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100_000);
    expect(
      (
        await call('/api/agents/event', {
          token: agent.token,
          headers: leaseHeaders(agent, assigned),
          body: { sequence: 2, executionState: 'passed' },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call<JobStatus>(`/api/runs/${jobId}`)).body.job.execution_state,
    ).toBe('interrupted');
    expect((await call(`/api/runs/${jobId}/retry`, { body: {} })).status).toBe(
      200,
    );
    const retry = await claim(agent);
    expect(retry.attemptId).not.toBe(assigned.attemptId);
    expect(
      (
        await call('/api/agents/resume', {
          token: agent.token,
          body: {
            sessionId: agent.sessionId,
            attemptId: assigned.attemptId,
            leaseToken: assigned.leaseToken,
            executionState: 'passed',
          },
        })
      ).status,
    ).toBe(409);
  });

  it('publishes exact per-file captures only at commit and recovers receipts after controller restart', async () => {
    const agent = await register(await enroll());
    const jobId = await submit(agent);
    const assigned = await claim(agent);
    const coreTestId = generateTestID();
    const files = captureFiles(coreTestId);
    await finish(agent, assigned, coreTestId);
    const transfer = await begin(agent, assigned, coreTestId, files);
    for (const [filename, value] of Object.entries(files))
      expect(
        (await upload(agent, assigned, transfer.transferId, filename, value))
          .status,
      ).toBe(200);
    expect(store.results()).toEqual([]);
    expect(fs.existsSync(path.join(directory, assigned.resultId))).toBe(false);
    const committed = await call<{ receipt: Receipt }>(
      '/api/agents/commit-files',
      {
        token: agent.token,
        headers: leaseHeaders(agent, assigned),
        body: { transferId: transfer.transferId },
      },
    );
    expect(committed.status).toBe(200);
    expect(committed.body.receipt).toMatchObject({
      resultId: assigned.resultId,
      coreTestId,
      stored: true,
      checksum: transfer.checksum,
      resultUrl: `/#result/${assigned.resultId}`,
    });
    for (const [filename, value] of Object.entries(files))
      expect(
        fs.readFileSync(path.join(directory, assigned.resultId, filename)),
      ).toEqual(Buffer.from(value));
    expect(store.results()).toMatchObject([
      { testId: assigned.resultId, url: TARGET, status: 'passed' },
    ]);
    controller.close();
    store.close();
    open();
    const recovered = await call<{ receipt: Receipt }>('/api/agents/resume', {
      token: agent.token,
      body: {
        sessionId: agent.sessionId,
        attemptId: assigned.attemptId,
        leaseToken: assigned.leaseToken,
        executionState: 'passed',
        coreTestId,
      },
    });
    expect(recovered.body.receipt).toEqual(committed.body.receipt);
    expect(
      (await call<JobStatus>(`/api/runs/${jobId}`)).body.job.delivery_state,
    ).toBe('stored');
    await call(`/api/agents/${agent.id}/revoke`, { body: {} });
    expect(
      (
        await call('/api/agents/receipt', {
          token: agent.token,
          headers: leaseHeaders(agent, assigned),
          body: {},
        })
      ).status,
    ).toBe(401);
    expect(store.result(assigned.resultId)).toHaveProperty('metrics');
    expect(store.results()).toHaveLength(1);
  });

  it('rejects corrupt uploads and wrong-target captures without exposing a result', async () => {
    const agent = await register(await enroll());
    await submit(agent);
    const assigned = await claim(agent);
    const coreTestId = generateTestID();
    const files = captureFiles(coreTestId, 'https://unassigned.internal/');
    await finish(agent, assigned, coreTestId);
    const transfer = await begin(agent, assigned, coreTestId, files);
    const bad = new Uint8Array(files['metrics.json']);
    bad[0] ^= 1;
    const rejected = await upload(
      agent,
      assigned,
      transfer.transferId,
      'metrics.json',
      bad,
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/checksum/);
    for (const [filename, value] of Object.entries(files))
      expect(
        (await upload(agent, assigned, transfer.transferId, filename, value))
          .status,
      ).toBe(200);
    const committed = await call('/api/agents/commit-files', {
      token: agent.token,
      headers: leaseHeaders(agent, assigned),
      body: { transferId: transfer.transferId },
    });
    expect(committed.status).toBe(400);
    expect(committed.body.error).toMatch(/target/);
    expect(store.results()).toEqual([]);
    expect(fs.existsSync(path.join(directory, assigned.resultId))).toBe(false);
  });

  it('does not accept a progress request whose credential is revoked while its body arrives', async () => {
    const agent = await register(await enroll());
    const jobId = await submit(agent);
    const assigned = await claim(agent);
    let release: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        release = () => {
          stream.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ sequence: 1, executionState: 'passed' }),
            ),
          );
          stream.close();
        };
      },
    });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      duplex: 'half',
      body,
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
        ...leaseHeaders(agent, assigned),
      },
    };
    const pending = controller.handle(
      new Request(`${ORIGIN}/api/agents/event`, init),
    );
    await call(`/api/agents/${agent.id}/revoke`, { body: {} });
    release!();
    const response = await pending;
    expect(response?.status).toBe(409);
    expect(
      (await call<JobStatus>(`/api/runs/${jobId}`)).body.job.execution_state,
    ).toBe('claimed');
  });

  it.each(['register', 'ping', 'claim', 'resume'])(
    'reauthenticates %s when a credential is revoked during request delivery',
    async action => {
      const agent = await register(await enroll());
      const jobId = await submit(agent);
      const assigned = await claim(agent);
      const payload =
        action === 'register'
          ? {
              protocolVersion: 1,
              sessionId: crypto.randomUUID(),
              capabilities: {
                browsers: ['chromium'],
                platform: 'linux',
                architecture: 'x64',
                version: 'fixture',
                allowHosts: ['app.internal'],
              },
            }
          : action === 'resume'
            ? {
                sessionId: agent.sessionId,
                attemptId: assigned.attemptId,
                leaseToken: assigned.leaseToken,
                executionState: 'failed',
              }
            : { sessionId: agent.sessionId };
      let release: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          release = () => {
            stream.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
            stream.close();
          };
        },
      });
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        duplex: 'half',
        body,
        headers: {
          authorization: `Bearer ${agent.token}`,
          'content-type': 'application/json',
        },
      };
      const pending = controller.handle(
        new Request(`${ORIGIN}/api/agents/${action}`, init),
      );
      await call(`/api/agents/${agent.id}/revoke`, { body: {} });
      release!();
      expect((await pending)?.status).toBe(401);
      expect(
        (await call<JobStatus>(`/api/runs/${jobId}`)).body.job.execution_state,
      ).toBe('claimed');
    },
  );
});
