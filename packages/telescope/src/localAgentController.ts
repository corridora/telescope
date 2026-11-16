import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import ejs from 'ejs';
import { z } from 'zod';

import {
  ArtifactPathSchema,
  IdentityManifestSchema,
  ResultManifestSchema,
  ScenarioManifestSchema,
  TestIdSchema,
} from './contracts.js';
import { generateTestID } from './helpers.js';
import { parseLocalOptions } from './localOptions.js';
import type { LocalStore } from './localStore.js';

const UUID = z.string().uuid();
const LEASE_MS = 90_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 10_000;
const Descriptor = z.object({
  size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const Terminal = z.enum(['passed', 'failed', 'cancelled', 'interrupted']);

interface Agent {
  id: string;
  name: string;
  tokenHash: string;
  status: 'active' | 'draining' | 'revoked';
  capabilities: Record<string, unknown>;
  sessionId?: string;
  lastSeen?: number;
  createdAt: number;
}

interface RemoteJob {
  id: string;
  agent_id: string;
  name?: string;
  description?: string;
  options: Record<string, unknown>;
  requestHash: string;
  idempotencyKey: string;
  execution_state: string;
  delivery_state: string;
  active_attempt_id?: string;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
  error?: string;
  delivery_error?: string;
}

interface Receipt {
  resultId: string;
  testId: string;
  coreTestId?: string;
  stored: true;
  checksum: string;
  resultUrl: string;
}

interface Attempt {
  id: string;
  job_id: string;
  agent_id: string;
  sessionId: string;
  leaseHash: string;
  lease_until: number;
  execution_state: string;
  delivery_state: string;
  event_sequence: number;
  progress?: Record<string, unknown>;
  coreTestId?: string;
  result_id: string;
  receipt?: Receipt;
  error?: string;
  delivery_error?: string;
  created_at: number;
  updated_at: number;
  transfer?: {
    id: string;
    checksum: string;
    files: Record<string, { size: number; sha256: string }>;
    received: Record<string, boolean>;
  };
}

interface ControllerState {
  schemaVersion: 1;
  agents: Record<string, Agent>;
  jobs: Record<string, RemoteJob>;
  attempts: Record<string, Attempt>;
}

function hash(value: string | Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function matches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hash(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function atomicJson(filename: string, value: unknown): void {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function expectedArtifact(filename: string): boolean {
  if (
    !ArtifactPathSchema.safeParse(filename).success ||
    filename.split('/').some(part => part.startsWith('.'))
  )
    return false;
  if (
    /^(config|metrics|resources|console|result|identity|scenario)\.json$/.test(
      filename,
    )
  )
    return true;
  if (
    ['pageload.har', 'screenshot.png', 'engine.png', 'index.html'].includes(
      filename,
    )
  )
    return true;
  if (/^[^/]+\.webm$/.test(filename)) return true;
  if (/^filmstrip\/[^/]+\.(jpg|png)$/.test(filename)) return true;
  if (/^baseline\/[a-zA-Z0-9_./-]+\.json$/.test(filename)) return true;
  return /^steps\/\d{4}\/((metrics|resources|console)\.json|pageload\.har|screenshot\.png|index\.html|video\.webm|filmstrip\/[^/]+\.(jpg|png))$/.test(
    filename,
  );
}

async function bytes(request: Request, maximum: number): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') ?? 0) > maximum)
    throw new Error('Request exceeds size limit');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('Request exceeds size limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function requestJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new Error('Expected application/json');
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      await bytes(request, MAX_JSON_BYTES),
    ),
  );
}

function publicJob(job: RemoteJob): Record<string, unknown> {
  const {
    options: _options,
    requestHash: _requestHash,
    idempotencyKey: _key,
    ...publicFields
  } = job;
  return publicFields;
}

function publicAttempt(attempt: Attempt): Record<string, unknown> {
  const {
    leaseHash: _leaseHash,
    sessionId: _session,
    transfer: _transfer,
    ...publicFields
  } = attempt;
  return publicFields;
}

/**
 * Creates the filesystem controller for the same protocol used by hosted agents.
 * The owning local server supplies its existing workspace lock and session policy.
 */
export function createLocalAgentController(options: {
  store: LocalStore;
  authorizeAdmin: (request: Request) => boolean;
}): {
  handle: (request: Request) => Promise<Response | null>;
  close: () => void;
} {
  const { store } = options;
  const root = path.join(store.metadataRoot, 'remote');
  const staging = path.join(root, 'staging');
  for (const directory of [root, staging]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      fs.lstatSync(directory).isSymbolicLink() ||
      !fs
        .realpathSync(directory)
        .startsWith(`${fs.realpathSync(store.metadataRoot)}${path.sep}`)
    )
      throw new Error('Remote metadata escaped the workspace');
  }
  const statePath = path.join(root, 'controller.json');
  let state: ControllerState;
  if (fs.existsSync(statePath)) {
    if (
      fs.lstatSync(statePath).isSymbolicLink() ||
      fs.statSync(statePath).size > 64 * 1024 * 1024
    )
      throw new Error('Invalid local agent metadata');
    const parsed = JSON.parse(
      fs.readFileSync(statePath, 'utf8'),
    ) as ControllerState;
    if (
      parsed.schemaVersion !== 1 ||
      !parsed.agents ||
      !parsed.jobs ||
      !parsed.attempts
    )
      throw new Error('Unsupported local agent metadata version');
    state = parsed;
  } else state = { schemaVersion: 1, agents: {}, jobs: {}, attempts: {} };
  const persist = (): void => atomicJson(statePath, state);

  function publicationMetadata(
    attempt: Attempt,
    publicationState: 'staging' | 'committed',
  ): Record<string, unknown> {
    const job = state.jobs[attempt.job_id];
    return {
      publicationState,
      status: attempt.execution_state,
      source: 'agent',
      coreTestId: attempt.coreTestId,
      jobId: job.id,
      agentId: attempt.agent_id,
      name: job.name,
      description: job.description,
    };
  }

  function repairCommittedPublication(attempt: Attempt): void {
    const metadataPath = path.join(
      store.metadataRoot,
      'runs',
      `${TestIdSchema.parse(attempt.result_id)}.json`,
    );
    if (!attempt.receipt || !fs.existsSync(metadataPath)) return;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      publicationState?: string;
    };
    if (metadata.publicationState !== 'staging') return;
    if (!attempt.transfer)
      throw new Error('Committed result lacks its recovery manifest');
    const directory = path.join(store.root, attempt.result_id);
    if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink())
      throw new Error('Committed capture is unavailable for recovery');
    for (const [filename, expected] of Object.entries(attempt.transfer.files)) {
      const full = path.join(directory, filename);
      if (
        !fs.existsSync(full) ||
        fs.lstatSync(full).isSymbolicLink() ||
        fs.statSync(full).size !== expected.size ||
        hash(fs.readFileSync(full)) !== expected.sha256
      )
        throw new Error(`Committed capture recovery failed for ${filename}`);
    }
    attempt.delivery_state = 'stored';
    attempt.delivery_error = undefined;
    attempt.updated_at = Date.now();
    const job = state.jobs[attempt.job_id];
    if (job?.active_attempt_id === attempt.id) {
      job.delivery_state = 'stored';
      job.delivery_error = undefined;
      job.updated_at = Date.now();
    }
    persist();
    atomicJson(metadataPath, publicationMetadata(attempt, 'committed'));
  }

  const reconcile = (): void => {
    let changed = false;
    const now = Date.now();
    for (const job of Object.values(state.jobs)) {
      if (job.execution_state === 'queued' && job.expires_at <= now) {
        job.execution_state = 'interrupted';
        job.error = 'Queue deadline expired';
        job.updated_at = now;
        changed = true;
      }
    }
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.receipt) {
        try {
          repairCommittedPublication(attempt);
        } catch (error) {
          attempt.delivery_state = 'failed';
          attempt.delivery_error = `Publication recovery failed: ${(error as Error).message}`;
          const job = state.jobs[attempt.job_id];
          if (job?.active_attempt_id === attempt.id) {
            job.delivery_state = 'failed';
            job.delivery_error = attempt.delivery_error;
            job.updated_at = now;
          }
          changed = true;
        }
        continue;
      }
      if (
        attempt.lease_until >= now ||
        ['stored', 'unavailable'].includes(attempt.delivery_state)
      )
        continue;
      if (
        !['passed', 'failed', 'cancelled', 'interrupted'].includes(
          attempt.execution_state,
        )
      )
        attempt.execution_state = 'interrupted';
      if (attempt.delivery_state === 'failed' && attempt.error) continue;
      attempt.delivery_state = 'failed';
      attempt.error ??= 'Agent lease expired';
      attempt.updated_at = now;
      const job = state.jobs[attempt.job_id];
      if (job?.active_attempt_id === attempt.id) {
        job.execution_state = attempt.execution_state;
        job.delivery_state = attempt.delivery_state;
        job.error = attempt.error;
        job.updated_at = now;
      }
      changed = true;
    }
    if (changed) persist();
  };
  reconcile();
  const timer = setInterval(() => {
    try {
      reconcile();
    } catch (error) {
      console.error(`Agent reconciliation: ${(error as Error).message}`);
    }
  }, 10_000);
  timer.unref();

  const authenticate = (request: Request): Agent | null => {
    const token = request.headers
      .get('authorization')
      ?.replace(/^Bearer /i, '');
    if (!token) return null;
    const id = token.split('.')[0];
    if (!UUID.safeParse(id).success) return null;
    const agent = state.agents[id];
    return agent &&
      agent.status !== 'revoked' &&
      matches(token, agent.tokenHash)
      ? agent
      : null;
  };

  const attemptFor = (
    request: Request,
    agent: Agent,
    allowStored = false,
  ): Attempt | null => {
    const id = request.headers.get('x-telescope-attempt') ?? '';
    const token = request.headers.get('x-telescope-lease');
    const session = request.headers.get('x-telescope-session');
    if (!UUID.safeParse(id).success || !token || !session) return null;
    const attempt = state.attempts[id];
    if (
      !attempt ||
      attempt.agent_id !== agent.id ||
      state.jobs[attempt.job_id]?.active_attempt_id !== id ||
      !matches(token, attempt.leaseHash)
    )
      return null;
    if (allowStored && attempt.receipt) return attempt;
    return attempt.sessionId === session &&
      agent.sessionId === session &&
      attempt.lease_until >= Date.now()
      ? attempt
      : null;
  };

  const stageDirectory = (attempt: Attempt): string => {
    UUID.parse(attempt.id);
    const directory = path.join(staging, attempt.id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error('Invalid staging directory');
    return directory;
  };

  const assertCurrent = (attempt: Attempt): void => {
    if (
      state.jobs[attempt.job_id]?.active_attempt_id !== attempt.id ||
      state.agents[attempt.agent_id]?.status === 'revoked' ||
      state.agents[attempt.agent_id]?.sessionId !== attempt.sessionId ||
      attempt.lease_until < Date.now()
    )
      throw new Error('Attempt expired or was superseded');
  };

  const writeArtifact = (
    attempt: Attempt,
    filename: string,
    data: Uint8Array,
  ): void => {
    if (!attempt.transfer || !expectedArtifact(filename))
      throw new Error('Unknown capture artifact');
    const expected = attempt.transfer.files[filename];
    if (
      !expected ||
      expected.size !== data.byteLength ||
      expected.sha256 !== hash(data)
    )
      throw new Error('Artifact checksum/size mismatch');
    const directory = stageDirectory(attempt);
    const destination = path.join(directory, filename);
    const parents = filename.split('/').slice(0, -1);
    let parent = directory;
    for (const part of parents) {
      parent = path.join(parent, part);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(parent).isSymbolicLink())
        throw new Error('Invalid artifact directory');
    }
    if (fs.existsSync(destination)) {
      if (fs.lstatSync(destination).isSymbolicLink())
        throw new Error('Invalid staged artifact');
      if (hash(fs.readFileSync(destination)) !== expected.sha256)
        throw new Error('Conflicting artifact already staged');
    } else {
      const descriptor = fs.openSync(destination, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, data);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    attempt.transfer.received[filename] = true;
    attempt.updated_at = Date.now();
    persist();
  };

  const beginTransfer = (
    attempt: Attempt,
    raw: unknown,
  ): Record<string, unknown> => {
    assertCurrent(attempt);
    const parsed = z
      .object({
        files: z.record(ArtifactPathSchema, Descriptor),
        coreTestId: TestIdSchema.optional(),
        executionState: Terminal,
      })
      .parse(raw);
    const files = Object.keys(parsed.files)
      .sort()
      .map(filename => [filename, parsed.files[filename]] as const);
    if (files.length === 0 || files.length > MAX_FILES)
      throw new Error('Invalid capture file count');
    if (files.some(([filename]) => !expectedArtifact(filename)))
      throw new Error('Unknown capture artifact');
    for (const [filename, descriptor] of files) {
      if (
        (filename.endsWith('.json') && descriptor.size > 8 * 1024 * 1024) ||
        (filename.endsWith('.har') && descriptor.size > 16 * 1024 * 1024) ||
        (['config.json', 'result.json', 'scenario.json'].includes(filename) &&
          descriptor.size > 1024 * 1024)
      )
        throw new Error(`Artifact ${filename} exceeds the transfer size limit`);
    }
    if (
      files.reduce((total, [, value]) => total + value.size, 0) >
      MAX_TOTAL_BYTES
    )
      throw new Error('Capture exceeds total transfer limit');
    if (!parsed.files['config.json'] || !parsed.files['result.json'])
      throw new Error('A remote capture requires config.json and result.json');
    const checksum = hash(
      JSON.stringify(
        files.map(([filename, descriptor]) => [
          filename,
          descriptor.size,
          descriptor.sha256,
        ]),
      ),
    );
    if (attempt.receipt) {
      if (attempt.receipt.checksum !== checksum)
        throw new Error('Conflicting committed capture');
      repairCommittedPublication(attempt);
      return {
        transferId: attempt.transfer?.id,
        resultId: attempt.result_id,
        testId: attempt.result_id,
        stored: true,
        checksum,
      };
    }
    if (attempt.transfer && attempt.transfer.checksum !== checksum)
      throw new Error('Attempt is already bound to different files');
    attempt.transfer ??= {
      id: crypto.randomUUID(),
      checksum,
      files: Object.fromEntries(files),
      received: {},
    };
    attempt.execution_state = parsed.executionState;
    attempt.coreTestId = parsed.coreTestId;
    attempt.delivery_state = 'uploading';
    attempt.updated_at = Date.now();
    const job = state.jobs[attempt.job_id];
    job.execution_state = parsed.executionState;
    job.delivery_state = 'uploading';
    job.updated_at = Date.now();
    stageDirectory(attempt);
    persist();
    return {
      transferId: attempt.transfer.id,
      resultId: attempt.result_id,
      testId: attempt.result_id,
      stored: false,
      checksum,
      limits: {
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxFiles: MAX_FILES,
      },
    };
  };

  const commitTransfer = (attempt: Attempt): Receipt => {
    if (attempt.receipt) {
      repairCommittedPublication(attempt);
      return attempt.receipt;
    }
    assertCurrent(attempt);
    if (!attempt.transfer)
      throw new Error('Begin a capture transfer before committing');
    const staged = stageDirectory(attempt);
    const committed = path.join(
      store.root,
      TestIdSchema.parse(attempt.result_id),
    );
    const directory = fs.existsSync(committed) ? committed : staged;
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error('Invalid capture directory');
    for (const [filename, expected] of Object.entries(attempt.transfer.files)) {
      const full = path.join(directory, filename);
      if (
        !fs.existsSync(full) ||
        fs.lstatSync(full).isSymbolicLink() ||
        fs.statSync(full).size !== expected.size ||
        hash(fs.readFileSync(full)) !== expected.sha256
      )
        throw new Error(`Missing or corrupt artifact: ${filename}`);
    }
    const read = (filename: string): unknown =>
      JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    const config = z
      .object({
        url: z.string().url(),
        options: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .parse(read('config.json'));
    if (
      !['http:', 'https:'].includes(new URL(config.url).protocol) ||
      config.url !== state.jobs[attempt.job_id].options.url
    )
      throw new Error('Capture target does not match the assigned job');
    if (
      attempt.execution_state === 'passed' &&
      !attempt.transfer.files['scenario.json']
    ) {
      for (const filename of [
        'metrics.json',
        'resources.json',
        'console.json',
        'pageload.har',
      ]) {
        if (!attempt.transfer.files[filename])
          throw new Error(`Passed capture is missing ${filename}`);
      }
    }
    if (attempt.transfer.files['result.json']) {
      const capture = ResultManifestSchema.parse(read('result.json'));
      if (
        !Terminal.safeParse(capture.status).success ||
        capture.status !== attempt.execution_state
      )
        throw new Error(
          'Capture outcome does not match its finished execution attempt',
        );
      if (attempt.coreTestId && capture.testId !== attempt.coreTestId)
        throw new Error('Capture identity mismatch');
      attempt.coreTestId = capture.testId;
      for (const [filename, expected] of Object.entries(capture.artifacts)) {
        if (!expectedArtifact(filename)) continue;
        const transferred = attempt.transfer.files[filename];
        if (
          !transferred ||
          transferred.size !== expected.size ||
          transferred.sha256 !== expected.sha256
        )
          throw new Error(`Capture integrity mismatch: ${filename}`);
      }
    }
    if (attempt.transfer.files['identity.json']) {
      const identity = IdentityManifestSchema.parse(read('identity.json'));
      if (attempt.coreTestId && identity.testId !== attempt.coreTestId)
        throw new Error('Portable capture identity mismatch');
      attempt.coreTestId = identity.testId;
    }
    if (attempt.transfer.files['scenario.json']) {
      const scenario = ScenarioManifestSchema.parse(read('scenario.json'));
      if (
        !Terminal.safeParse(scenario.status).success ||
        scenario.status !== attempt.execution_state
      )
        throw new Error(
          'Scenario outcome does not match its finished execution attempt',
        );
      const stepIds = new Set(scenario.steps.map(step => step.id));
      for (const filename of Object.keys(attempt.transfer.files)) {
        if (!filename.startsWith('steps/')) continue;
        const match = /^steps\/(\d{4})\//.exec(filename);
        if (!match || !stepIds.has(match[1]))
          throw new Error('Artifact references an undeclared scenario step');
      }
      for (const step of scenario.steps) {
        if ((step.kind === 'interaction') !== (step.metricScope === 'interval'))
          throw new Error('Step kind and metric scope disagree');
        for (const [relative, expected] of Object.entries(
          step.artifacts ?? {},
        )) {
          const filename = `${step.artifactBase}/${ArtifactPathSchema.parse(relative)}`;
          if (!expectedArtifact(filename))
            throw new Error(`Unknown step artifact: ${filename}`);
          const transferred = attempt.transfer.files[filename];
          if (
            !transferred ||
            transferred.size !== expected.size ||
            transferred.sha256 !== expected.sha256
          )
            throw new Error(`Step ${step.id} integrity mismatch: ${relative}`);
        }
        if (step.status === 'passed') {
          for (const filename of [
            'metrics.json',
            'resources.json',
            'console.json',
            'pageload.har',
          ]) {
            if (!attempt.transfer.files[`${step.artifactBase}/${filename}`])
              throw new Error(`Passed step is missing ${filename}`);
          }
        }
        const metricsPath = `${step.artifactBase}/metrics.json`;
        if (
          step.kind === 'interaction' &&
          attempt.transfer.files[metricsPath]
        ) {
          const metrics = read(metricsPath);
          if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics))
            throw new Error(`Step ${step.id} has invalid metrics`);
          if (Reflect.get(metrics, 'navigationTiming') != null)
            throw new Error(
              'Interaction metrics must not contain inherited navigation timing',
            );
        }
      }
    } else if (
      Object.keys(attempt.transfer.files).some(filename =>
        filename.startsWith('steps/'),
      )
    )
      throw new Error('Step artifacts require a scenario manifest');
    attempt.delivery_state = 'validating';
    persist();
    assertCurrent(attempt);
    atomicJson(
      path.join(store.metadataRoot, 'runs', `${attempt.result_id}.json`),
      publicationMetadata(attempt, 'staging'),
    );
    assertCurrent(attempt);
    if (!fs.existsSync(committed)) fs.renameSync(staged, committed);
    const job = state.jobs[attempt.job_id];
    const receipt: Receipt = {
      resultId: attempt.result_id,
      testId: attempt.result_id,
      coreTestId: attempt.coreTestId,
      stored: true,
      checksum: attempt.transfer.checksum,
      resultUrl: `/#result/${attempt.result_id}`,
    };
    attempt.receipt = receipt;
    attempt.delivery_state = 'stored';
    attempt.updated_at = Date.now();
    job.execution_state = attempt.execution_state;
    job.delivery_state = 'stored';
    job.updated_at = Date.now();
    persist();
    atomicJson(
      path.join(store.metadataRoot, 'runs', `${attempt.result_id}.json`),
      publicationMetadata(attempt, 'committed'),
    );
    return receipt;
  };

  const handle = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, '');
    const agentApi =
      pathname === '/api/agents' || pathname.startsWith('/api/agents/');
    const runsApi =
      pathname === '/api/runs' || pathname.startsWith('/api/runs/');
    if (
      pathname === '/agents' ||
      pathname === '/run' ||
      /^\/runs\/[a-f0-9-]{36}$/.test(pathname)
    ) {
      const template = fs.readFileSync(
        new URL('./templates/agents.ejs', import.meta.url),
        'utf8',
      );
      const html = ejs.render(template, {
        mode:
          pathname === '/agents'
            ? 'agents'
            : pathname === '/run'
              ? 'run'
              : 'job',
        jobId: pathname.startsWith('/runs/') ? pathname.slice(6) : '',
      });
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        },
      });
    }
    if (!agentApi && !runsApi) return null;
    try {
      reconcile();
      const action = pathname
        .slice(agentApi ? '/api/agents'.length : '/api/runs'.length)
        .replace(/^\//, '');
      const method = request.method;
      const administrativeAgentAction =
        !action ||
        action === 'reconcile' ||
        /^[a-f0-9-]{36}\/(revoke|drain|activate|rotate)$/.test(action);
      if (runsApi || administrativeAgentAction) {
        if (!options.authorizeAdmin(request))
          return json(
            { error: 'Local workspace authentication required' },
            401,
          );
        if (agentApi) {
          if (!action && method === 'GET')
            return json({
              protocolVersion: 1,
              agents: Object.values(state.agents).map(agent => ({
                id: agent.id,
                name: agent.name,
                status: agent.status,
                online: Boolean(
                  agent.lastSeen && agent.lastSeen > Date.now() - LEASE_MS,
                ),
                lastSeen: agent.lastSeen ?? null,
                capabilities: agent.capabilities,
              })),
            });
          if (!action && method === 'POST') {
            const parsed = z
              .object({ name: z.string().trim().min(1).max(100) })
              .parse(await requestJson(request));
            const id = crypto.randomUUID();
            const token = `${id}.${crypto.randomUUID()}${crypto.randomUUID()}`;
            state.agents[id] = {
              id,
              name: parsed.name,
              tokenHash: hash(token),
              status: 'active',
              capabilities: {},
              createdAt: Date.now(),
            };
            persist();
            return json({ id, token, protocolVersion: 1 }, 201);
          }
          if (action === 'reconcile' && method === 'POST')
            return json({ success: true });
          if (method === 'POST') {
            const [id, verb] = action.split('/');
            UUID.parse(id);
            const agent = state.agents[id];
            if (!agent) return json({ error: 'Agent not found' }, 404);
            if (verb === 'rotate') {
              const token = `${id}.${crypto.randomUUID()}${crypto.randomUUID()}`;
              agent.tokenHash = hash(token);
              agent.sessionId = undefined;
              agent.status = 'active';
              persist();
              return json({ id, token });
            }
            agent.status =
              verb === 'revoke'
                ? 'revoked'
                : verb === 'drain'
                  ? 'draining'
                  : 'active';
            persist();
            return json({ success: true });
          }
          return json({ error: 'Method not allowed' }, 405);
        }
        if (!action && method === 'GET')
          return json({
            jobs: Object.values(state.jobs)
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, 100)
              .map(job => ({
                ...publicJob(job),
                agent_name: state.agents[job.agent_id]?.name ?? 'Removed agent',
              })),
          });
        if (!action && method === 'POST') {
          const parsed = z
            .object({
              agentId: UUID,
              name: z.string().max(200).optional(),
              description: z.string().max(4000).optional(),
              options: z.record(z.string(), z.unknown()),
            })
            .parse(await requestJson(request));
          const forbidden = [
            'resultsDir',
            'uploadUrl',
            'openHtml',
            'list',
            'zip',
            'dry',
            'script',
            'args',
            'signal',
            'onProgress',
            'allowedHosts',
            'overrideHost',
          ];
          if (Object.keys(parsed.options).some(key => forbidden.includes(key)))
            throw new Error(
              'Remote jobs cannot choose scripts, output paths, process flags, or delivery endpoints',
            );
          const { scriptId, scriptHash, scriptTimeout, ...baseOptions } =
            parsed.options;
          if ((scriptId === undefined) !== (scriptHash === undefined))
            throw new Error(
              'Trusted script ID and content hash must be provided together',
            );
          if (scriptId !== undefined) {
            z.string().min(1).max(200).parse(scriptId);
            z.string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(scriptHash);
          }
          if (scriptTimeout !== undefined)
            z.number().int().positive().max(3_600_000).parse(scriptTimeout);
          const deviceName =
            typeof baseOptions.device === 'string'
              ? baseOptions.device
              : typeof baseOptions.deviceName === 'string'
                ? baseOptions.deviceName
                : undefined;
          if (
            baseOptions.device !== undefined &&
            typeof baseOptions.device !== 'string'
          )
            throw new Error('Remote devices must use a registered device name');
          const normalized = parseLocalOptions(baseOptions);
          if ((normalized.timeout ?? 30_000) > 300_000)
            throw new Error('Remote timeout cannot exceed 300000 milliseconds');
          if (
            normalized.cpuThrottle &&
            !['chrome', 'chrome-beta', 'chromium', 'canary', 'edge'].includes(
              normalized.browser ?? 'chrome',
            )
          )
            throw new Error('CPU throttling requires a Chromium browser');
          if (scriptId && normalized.baseline)
            throw new Error(
              'Baseline analysis cannot be combined with scripts',
            );
          const validated = { ...normalized } as Record<string, unknown>;
          delete validated.resultsDir;
          delete validated.html;
          delete validated.headless;
          delete validated.device;
          if (deviceName) validated.device = deviceName;
          if (scriptId !== undefined) {
            validated.scriptId = scriptId;
            validated.scriptHash = scriptHash;
          }
          if (scriptTimeout !== undefined)
            validated.scriptTimeout = scriptTimeout;
          const key = request.headers.get('idempotency-key');
          if (!key || key.length > 200)
            throw new Error('A bounded Idempotency-Key is required');
          const digest = hash(
            JSON.stringify({
              agentId: parsed.agentId,
              name: parsed.name,
              description: parsed.description,
              options: validated,
            }),
          );
          const duplicate = Object.values(state.jobs).find(
            job => job.idempotencyKey === key,
          );
          if (duplicate)
            return duplicate.requestHash === digest
              ? json({ jobId: duplicate.id, duplicate: true })
              : json(
                  { error: 'Idempotency key is bound to another request' },
                  409,
                );
          const agent = state.agents[parsed.agentId];
          if (!agent || agent.status !== 'active')
            throw new Error('Agent is unavailable or disabled');
          if (
            !Array.isArray(agent.capabilities.browsers) ||
            !agent.capabilities.browsers.includes(normalized.browser)
          )
            throw new Error('Agent does not advertise the requested browser');
          if (
            deviceName &&
            (!Array.isArray(agent.capabilities.devices) ||
              !agent.capabilities.devices.includes(deviceName))
          )
            throw new Error('Agent does not advertise the requested device');
          if (normalized.connectionType && !agent.capabilities.throttling)
            throw new Error('Agent does not advertise network throttling');
          if (scriptId) {
            const scripts = z
              .array(
                z.object({ id: z.string(), sha256: z.string() }).passthrough(),
              )
              .parse(agent.capabilities.scripts ?? []);
            if (
              !scripts.some(
                script =>
                  script.id === scriptId && script.sha256 === scriptHash,
              )
            )
              throw new Error(
                'Agent does not advertise the selected script version',
              );
          }
          if (
            Object.values(state.jobs).filter(
              job => job.execution_state === 'queued',
            ).length >= 25
          )
            throw new Error('The remote execution queue is full');
          const now = Date.now();
          const id = crypto.randomUUID();
          state.jobs[id] = {
            id,
            agent_id: agent.id,
            name: parsed.name,
            description: parsed.description,
            options: validated,
            requestHash: digest,
            idempotencyKey: key,
            execution_state: 'queued',
            delivery_state: 'not_started',
            cancel_requested: 0,
            created_at: now,
            updated_at: now,
            expires_at: now + 86_400_000,
          };
          persist();
          return json({ jobId: id, url: `/runs/${id}` }, 202);
        }
        const [id, verb] = action.split('/');
        UUID.parse(id);
        const job = state.jobs[id];
        if (!job) return json({ error: 'Job not found' }, 404);
        if (!verb && method === 'GET')
          return json({
            job: publicJob(job),
            attempts: Object.values(state.attempts)
              .filter(attempt => attempt.job_id === id)
              .sort((a, b) => a.created_at - b.created_at)
              .map(publicAttempt),
          });
        if (verb === 'cancel' && method === 'POST') {
          if (!Terminal.safeParse(job.execution_state).success) {
            job.cancel_requested = 1;
            if (job.execution_state === 'queued')
              job.execution_state = 'cancelled';
            job.updated_at = Date.now();
            persist();
          }
          return json({ success: true });
        }
        if (verb === 'retry' && method === 'POST') {
          if (
            !['failed', 'cancelled', 'interrupted'].includes(
              job.execution_state,
            )
          )
            return json(
              { error: 'Only failed/interrupted jobs may be retried' },
              409,
            );
          job.execution_state = 'queued';
          job.delivery_state = 'not_started';
          job.active_attempt_id = undefined;
          job.cancel_requested = 0;
          job.error = undefined;
          job.updated_at = Date.now();
          job.expires_at = Date.now() + 86_400_000;
          persist();
          return json({ success: true, jobId: id });
        }
        return json({ error: 'Method not allowed' }, 405);
      }
      const agent = authenticate(request);
      if (!agent) return json({ error: 'Invalid agent credential' }, 401);
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (action === 'register') {
        const parsed = z
          .object({
            sessionId: UUID,
            protocolVersion: z.literal(1),
            capabilities: z
              .object({
                browsers: z.array(z.string()).max(7),
                platform: z.string(),
                architecture: z.string(),
                version: z.string(),
                allowHosts: z.array(z.string()).max(100),
              })
              .passthrough(),
          })
          .parse(await requestJson(request));
        agent.sessionId = parsed.sessionId;
        agent.capabilities = parsed.capabilities;
        agent.lastSeen = Date.now();
        persist();
        return json({
          protocolVersion: 1,
          leaseMs: LEASE_MS,
          maximumArchiveBytes: 16 * 1024 * 1024,
          fileTransfer: true,
        });
      }
      if (action === 'ping') {
        const parsed = z
          .object({ sessionId: UUID })
          .parse(await requestJson(request));
        if (agent.sessionId !== parsed.sessionId)
          return json({ error: 'Stale session' }, 409);
        agent.lastSeen = Date.now();
        persist();
        return json({ success: true });
      }
      if (action === 'claim') {
        const parsed = z
          .object({ sessionId: UUID })
          .parse(await requestJson(request));
        if (parsed.sessionId !== agent.sessionId)
          return json({ error: 'Stale session' }, 409);
        const now = Date.now();
        agent.lastSeen = now;
        const busy = Object.values(state.attempts).some(
          attempt =>
            attempt.agent_id === agent.id &&
            attempt.lease_until > now &&
            !['stored', 'unavailable'].includes(attempt.delivery_state),
        );
        if (busy || agent.status !== 'active') {
          persist();
          return json({ job: null });
        }
        const job = Object.values(state.jobs)
          .filter(
            item =>
              item.agent_id === agent.id &&
              item.execution_state === 'queued' &&
              item.expires_at > now,
          )
          .sort((a, b) => a.created_at - b.created_at)[0];
        if (!job) {
          persist();
          return json({ job: null });
        }
        const id = crypto.randomUUID();
        const leaseToken = crypto.randomUUID();
        const resultId = generateTestID();
        state.attempts[id] = {
          id,
          job_id: job.id,
          agent_id: agent.id,
          sessionId: parsed.sessionId,
          leaseHash: hash(leaseToken),
          lease_until: now + LEASE_MS,
          execution_state: 'claimed',
          delivery_state: 'not_started',
          event_sequence: 0,
          result_id: resultId,
          created_at: now,
          updated_at: now,
        };
        job.active_attempt_id = id;
        job.execution_state = 'claimed';
        job.updated_at = now;
        persist();
        return json({
          job: {
            id: job.id,
            attemptId: id,
            leaseToken,
            leaseUntil: now + LEASE_MS,
            resultId,
            options: job.options,
          },
        });
      }
      if (action === 'resume') {
        const parsed = z
          .object({
            sessionId: UUID,
            attemptId: UUID,
            leaseToken: UUID,
            executionState: Terminal,
            coreTestId: TestIdSchema.optional(),
          })
          .parse(await requestJson(request));
        const attempt = state.attempts[parsed.attemptId];
        if (
          !attempt ||
          attempt.agent_id !== agent.id ||
          agent.sessionId !== parsed.sessionId ||
          state.jobs[attempt.job_id]?.active_attempt_id !== attempt.id ||
          !matches(parsed.leaseToken, attempt.leaseHash)
        )
          return json(
            { error: 'Attempt was superseded', code: 'superseded' },
            409,
          );
        if (attempt.receipt) {
          repairCommittedPublication(attempt);
          return json({ receipt: attempt.receipt });
        }
        const token = crypto.randomUUID();
        attempt.sessionId = parsed.sessionId;
        attempt.leaseHash = hash(token);
        attempt.lease_until = Date.now() + LEASE_MS;
        attempt.event_sequence = 0;
        attempt.execution_state = parsed.executionState;
        attempt.coreTestId = parsed.coreTestId;
        attempt.delivery_state = 'uploading';
        attempt.updated_at = Date.now();
        const job = state.jobs[attempt.job_id];
        job.execution_state = parsed.executionState;
        job.delivery_state = 'uploading';
        job.updated_at = Date.now();
        persist();
        return json({ leaseToken: token, leaseUntil: attempt.lease_until });
      }
      const attempt = attemptFor(request, agent, action === 'receipt');
      if (!attempt)
        return json({ error: 'Invalid, expired, or superseded attempt' }, 409);
      if (action === 'receipt') {
        repairCommittedPublication(attempt);
        return json({ receipt: attempt.receipt ?? null });
      }
      if (action === 'heartbeat' || action === 'event') {
        const parsed = z
          .object({
            sequence: z.number().int().nonnegative(),
            executionState: z
              .enum([
                'claimed',
                'running',
                'finalizing',
                'passed',
                'failed',
                'cancelled',
                'interrupted',
              ])
              .optional(),
            coreTestId: TestIdSchema.optional(),
            progress: z.record(z.string(), z.unknown()).optional(),
            error: z.string().max(2048).optional(),
            deliveryError: z.string().max(2048).optional(),
            noArtifacts: z.boolean().optional(),
          })
          .parse(await requestJson(request));
        if (!attemptFor(request, agent))
          return json({ error: 'Attempt expired before progress update' }, 409);
        if (parsed.sequence > attempt.event_sequence) {
          attempt.event_sequence = parsed.sequence;
          attempt.lease_until = Date.now() + LEASE_MS;
          if (
            parsed.executionState &&
            !Terminal.safeParse(attempt.execution_state).success
          )
            attempt.execution_state = parsed.executionState;
          if (parsed.coreTestId) attempt.coreTestId = parsed.coreTestId;
          if (parsed.progress) attempt.progress = parsed.progress;
          if (parsed.error) attempt.error = parsed.error;
          if (parsed.deliveryError)
            attempt.delivery_error = parsed.deliveryError;
          if (parsed.noArtifacts) attempt.delivery_state = 'unavailable';
          agent.lastSeen = Date.now();
          attempt.updated_at = Date.now();
          const job = state.jobs[attempt.job_id];
          job.execution_state = attempt.execution_state;
          job.delivery_state = attempt.delivery_state;
          job.error = attempt.error;
          job.delivery_error = attempt.delivery_error;
          job.updated_at = Date.now();
          persist();
        }
        return json({
          leaseUntil: attempt.lease_until,
          cancelRequested: Boolean(state.jobs[attempt.job_id].cancel_requested),
        });
      }
      if (action === 'begin-files') {
        const parsed = await requestJson(request);
        if (!attemptFor(request, agent))
          return json({ error: 'Attempt expired before transfer began' }, 409);
        return json(beginTransfer(attempt, parsed));
      }
      if (action === 'upload-file') {
        const transfer = request.headers.get('x-telescope-transfer');
        const filename = decodeURIComponent(
          request.headers.get('x-telescope-artifact') ?? '',
        );
        if (!attempt.transfer || transfer !== attempt.transfer.id)
          throw new Error('Invalid transfer ID');
        const value = await bytes(request, MAX_FILE_BYTES);
        if (!attemptFor(request, agent))
          return json({ error: 'Attempt expired during transfer' }, 409);
        writeArtifact(attempt, filename, value);
        return json({ stored: true, filename });
      }
      if (action === 'commit-files') {
        const parsed = z
          .object({ transferId: UUID })
          .parse(await requestJson(request));
        if (!attemptFor(request, agent))
          return json({ error: 'Attempt expired before commit' }, 409);
        if (parsed.transferId !== attempt.transfer?.id)
          throw new Error('Invalid transfer ID');
        return json({ receipt: commitTransfer(attempt) });
      }
      if (action === 'upload') {
        if (attempt.receipt) return json({ receipt: attempt.receipt });
        if (!Terminal.safeParse(attempt.execution_state).success)
          return json({ error: 'Capture must finish before delivery' }, 409);
        const archive = Buffer.from(await bytes(request, MAX_ZIP_BYTES));
        if (!attemptFor(request, agent))
          return json({ error: 'Attempt expired during transfer' }, 409);
        const entries = new AdmZip(archive).getEntries();
        if (entries.length > MAX_FILES)
          throw new Error('Too many archive entries');
        const seen = new Set<string>();
        const files: Record<string, { size: number; sha256: string }> = {};
        let total = 0;
        const normalized = entries
          .filter(entry => !entry.isDirectory)
          .map(entry => {
            const filename = entry.entryName.replace(/\\/g, '/');
            ArtifactPathSchema.parse(filename);
            if (seen.has(filename)) throw new Error('Duplicate archive path');
            seen.add(filename);
            const mode =
              ((entry as { attr?: number }).attr ??
                (entry.header as { attr?: number }).attr ??
                0) >>> 16;
            if ((mode & 0o170000) === 0o120000)
              throw new Error('Symlink archive entry');
            total += entry.header.size;
            if (entry.header.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES)
              throw new Error('Archive exceeds expanded-size limit');
            return { filename, entry };
          })
          .filter(item => expectedArtifact(item.filename));
        for (const item of normalized) {
          const value = item.entry.getData();
          files[item.filename] = { size: value.length, sha256: hash(value) };
        }
        beginTransfer(attempt, {
          files,
          coreTestId: attempt.coreTestId,
          executionState: attempt.execution_state,
        });
        for (const item of normalized)
          writeArtifact(attempt, item.filename, item.entry.getData());
        const receipt = commitTransfer(attempt);
        receipt.checksum = hash(archive);
        persist();
        return json({ receipt });
      }
      return json({ error: 'Unknown agent action' }, 404);
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : 'Agent request failed',
        },
        400,
      );
    }
  };
  return { handle, close: () => clearInterval(timer) };
}
