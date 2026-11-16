import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { DEFAULT_OPTIONS } from '@cloudflare/telescope/defaults';

import type { APIContext } from 'astro';
import type { AgentRecord, AttemptRecord, JobRecord } from './types';

import { getBindingString, requireAdmin, tokenMatches } from '@/lib/auth';
import {
  IngestionError,
  ingestResultArchive,
  parseResultArchive,
} from '@/lib/storage/resultStore';
import {
  beginAgentTransfer,
  commitAgentTransfer,
  uploadAgentArtifact,
} from '@/lib/storage/agentTransfer';
import { TestSource } from '@/lib/types/tests';
import { generateTestId } from '@/lib/utils/testId';
import { MAX_ARCHIVE_BYTES } from '@/lib/utils/security';

const LEASE_MS = 90_000;
const MAX_JSON = 128 * 1024;
const MAX_ZIP = MAX_ARCHIVE_BYTES;
const Id = z.string().uuid();
const HttpUrl = z
  .string()
  .max(4096)
  .url()
  .refine(value => /^https?:\/\//i.test(value));
const Browser = z.enum([
  'chrome',
  'chrome-beta',
  'chromium',
  'canary',
  'firefox',
  'safari',
  'edge',
]);
const Config = z
  .object({
    url: HttpUrl,
    browser: Browser.optional(),
    device: z.string().max(200).optional(),
    scriptId: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
      .optional(),
    scriptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    scriptTimeout: z.number().int().positive().max(900_000).optional(),
    width: z.number().int().positive().max(8192).optional(),
    height: z.number().int().positive().max(8192).optional(),
    timeout: z
      .number()
      .int()
      .positive()
      .max(300_000)
      .default(DEFAULT_OPTIONS.timeout),
    frameRate: z.number().int().positive().max(30).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    cookies: z
      .union([
        z.record(z.string(), z.unknown()),
        z.array(z.record(z.string(), z.unknown())),
      ])
      .optional(),
    auth: z
      .object({
        username: z.string(),
        password: z.string(),
        origin: HttpUrl.optional(),
      })
      .optional(),
    block: z.array(z.string().max(2048)).max(100).optional(),
    blockDomains: z.array(z.string().max(255)).max(100).optional(),
    delay: z
      .record(z.string(), z.number().nonnegative().max(60_000))
      .optional(),
    delayUsing: z.enum(['continue', 'fulfill']).optional(),
    connectionType: z
      .union([
        z.literal(false),
        z.enum(['cable', 'dsl', '4g', '3g', '3gfast', '3gslow', '2g', 'fios']),
      ])
      .optional(),
    cpuThrottle: z.number().positive().max(100).optional(),
    disableJS: z.boolean().optional(),
    userAgent: z.string().max(4096).optional(),
    agentExtra: z.string().max(4096).optional(),
    firefoxPrefs: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  })
  .strict()
  .refine(
    value => Boolean(value.scriptId) === Boolean(value.scriptHash),
    'Script ID and version hash must be supplied together',
  );
const Session = z.object({ sessionId: Id });
const Terminal = z.enum(['passed', 'failed', 'cancelled', 'interrupted']);

async function secretKey(): Promise<CryptoKey> {
  const value = getBindingString(env, 'TELESCOPE_JOB_SECRET');
  if (!value || value.length < 32)
    throw new Error(
      'Configure TELESCOPE_JOB_SECRET (at least 32 characters) to dispatch jobs containing headers, cookies, or credentials',
    );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

function encode(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function protectOptions(options: z.infer<typeof Config>) {
  const { headers, cookies, auth, ...publicOptions } = options;
  if (headers === undefined && cookies === undefined && auth === undefined)
    return { options: publicOptions, secrets: null };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await secretKey(),
    new TextEncoder().encode(JSON.stringify({ headers, cookies, auth })),
  );
  return {
    options: publicOptions,
    secrets: JSON.stringify({
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
    }),
  };
}

async function dispatchOptions(
  job: JobRecord,
): Promise<Record<string, unknown>> {
  const options = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(job.options_json));
  if (!job.secrets_json) return options;
  const envelope = z
    .object({ iv: z.string(), ciphertext: z.string() })
    .parse(JSON.parse(job.secrets_json));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(envelope.iv) },
    await secretKey(),
    decode(envelope.ciphertext),
  );
  return {
    ...options,
    ...z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(new TextDecoder().decode(plaintext))),
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function body(context: APIContext, maximum = MAX_JSON): Promise<unknown> {
  if (
    !context.request.headers.get('content-type')?.includes('application/json')
  )
    throw new Error('Expected application/json');
  const bytes = await readBounded(context.request, maximum);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readBounded(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > maximum) throw new Error('Request exceeds size limit');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('Request exceeds size limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function authenticate(context: APIContext): Promise<AgentRecord | null> {
  const token = context.request.headers
    .get('authorization')
    ?.replace(/^Bearer /i, '');
  if (!token) return null;
  const id = token.split('.')[0];
  if (!Id.safeParse(id).success) return null;
  const agent = await env.TELESCOPE_DB.prepare(
    'SELECT * FROM telescope_agents WHERE id = ? AND status != ?',
  )
    .bind(id, 'revoked')
    .first<AgentRecord>();
  if (!agent || !(await tokenMatches(await hash(token), agent.token_hash)))
    return null;
  return agent;
}

/** Reconciles expired executions durably; may also be called by a scheduler. */
export async function reconcileAgentJobs(): Promise<void> {
  const now = Date.now();
  await env.TELESCOPE_DB.batch([
    env.TELESCOPE_DB.prepare(
      "UPDATE telescope_attempts SET execution_state = CASE WHEN execution_state IN ('passed','failed','cancelled','interrupted') THEN execution_state ELSE 'interrupted' END, delivery_state = CASE WHEN delivery_state = 'stored' THEN delivery_state ELSE 'failed' END, error = COALESCE(error, 'Agent lease expired'), updated_at = ? WHERE lease_until < ? AND delivery_state != 'stored'",
    ).bind(now, now),
    env.TELESCOPE_DB.prepare(
      "UPDATE telescope_jobs SET execution_state = COALESCE((SELECT execution_state FROM telescope_attempts WHERE id = active_attempt_id), execution_state), delivery_state = COALESCE((SELECT delivery_state FROM telescope_attempts WHERE id = active_attempt_id), delivery_state), error = COALESCE(error, (SELECT error FROM telescope_attempts WHERE id = active_attempt_id)), updated_at = ? WHERE active_attempt_id IN (SELECT id FROM telescope_attempts WHERE lease_until < ? AND delivery_state != 'stored')",
    ).bind(now, now),
    env.TELESCOPE_DB.prepare(
      "UPDATE telescope_jobs SET execution_state = 'interrupted', error = 'Queue deadline expired', updated_at = ? WHERE execution_state = 'queued' AND expires_at <= ?",
    ).bind(now, now),
  ]);
}

async function attemptFor(
  context: APIContext,
  agent: AgentRecord,
  allowStored = false,
): Promise<AttemptRecord | null> {
  const current = await authenticate(context);
  if (!current || current.id !== agent.id) return null;
  const attemptId = context.request.headers.get('x-telescope-attempt');
  const lease = context.request.headers.get('x-telescope-lease');
  const session = context.request.headers.get('x-telescope-session');
  if (
    !Id.safeParse(attemptId).success ||
    !lease ||
    !Id.safeParse(session).success
  )
    return null;
  const attempt = await env.TELESCOPE_DB.prepare(
    'SELECT a.* FROM telescope_attempts a JOIN telescope_jobs j ON j.active_attempt_id = a.id WHERE a.id = ? AND a.agent_id = ?',
  )
    .bind(attemptId, agent.id)
    .first<AttemptRecord>();
  if (!attempt || !(await tokenMatches(await hash(lease), attempt.lease_hash)))
    return null;
  if (allowStored && attempt.delivery_state === 'stored') return attempt;
  if (
    attempt.session_id !== session ||
    current.session_id !== session ||
    attempt.lease_until < Date.now()
  )
    return null;
  return attempt;
}

async function storeReceipt(
  attempt: AttemptRecord,
  receipt: { testId: string; resultId: string; stored: true; checksum: string },
): Promise<void> {
  const now = Date.now();
  const result = await env.TELESCOPE_DB.batch([
    env.TELESCOPE_DB.prepare(
      "UPDATE telescope_attempts SET delivery_state='stored',delivery_error=NULL,receipt_json=?,updated_at=? WHERE id=? AND lease_hash=? AND session_id=? AND EXISTS (SELECT 1 FROM telescope_jobs WHERE id=job_id AND active_attempt_id=telescope_attempts.id)",
    ).bind(
      JSON.stringify(receipt),
      now,
      attempt.id,
      attempt.lease_hash,
      attempt.session_id,
    ),
    env.TELESCOPE_DB.prepare(
      "UPDATE telescope_jobs SET delivery_state='stored',delivery_error=NULL,updated_at=? WHERE id=? AND active_attempt_id=? AND EXISTS (SELECT 1 FROM telescope_attempts WHERE id=? AND delivery_state='stored' AND lease_hash=?)",
    ).bind(now, attempt.job_id, attempt.id, attempt.id, attempt.lease_hash),
  ]);
  if (!result[0].meta.changes)
    throw new IngestionError(
      'Result stored but execution owner changed; reconcile receipt before cleanup',
      409,
    );
}

function publicAgent(agent: AgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    online: agent.last_seen !== null && agent.last_seen > Date.now() - LEASE_MS,
    lastSeen: agent.last_seen,
    capabilities: JSON.parse(agent.capabilities_json),
  };
}

/** Versioned agent registration, claims, progress, and result delivery API. */
export async function handleAgents(context: APIContext): Promise<Response> {
  try {
    const action = context.params.action ?? '';
    const method = context.request.method;
    if (
      !action ||
      action === 'reconcile' ||
      /^[a-f0-9-]{36}\/(revoke|drain|activate|rotate)$/.test(action)
    ) {
      const denied = await requireAdmin(context);
      if (denied) return denied;
      if (action === 'reconcile' && method === 'POST') {
        await reconcileAgentJobs();
        return json({ success: true });
      }
      if (!action && method === 'GET') {
        await reconcileAgentJobs();
        const records = await env.TELESCOPE_DB.prepare(
          'SELECT * FROM telescope_agents ORDER BY created_at DESC',
        ).all<AgentRecord>();
        return json({
          protocolVersion: 1,
          agents: records.results.map(publicAgent),
        });
      }
      if (!action && method === 'POST') {
        const parsed = z
          .object({ name: z.string().trim().min(1).max(100) })
          .parse(await body(context));
        const id = crypto.randomUUID();
        const token = `${id}.${crypto.randomUUID()}${crypto.randomUUID()}`;
        await env.TELESCOPE_DB.prepare(
          'INSERT INTO telescope_agents (id,name,token_hash,created_at) VALUES (?,?,?,?)',
        )
          .bind(id, parsed.name, await hash(token), Date.now())
          .run();
        return json({ id, token, protocolVersion: 1 }, 201);
      }
      if (action && method === 'POST') {
        const [id, verb] = action.split('/');
        if (verb === 'rotate') {
          const token = `${id}.${crypto.randomUUID()}${crypto.randomUUID()}`;
          await env.TELESCOPE_DB.prepare(
            'UPDATE telescope_agents SET token_hash = ?, session_id = NULL WHERE id = ? AND status != ?',
          )
            .bind(await hash(token), id, 'revoked')
            .run();
          return json({ id, token });
        }
        const state =
          verb === 'revoke'
            ? 'revoked'
            : verb === 'drain'
              ? 'draining'
              : 'active';
        await env.TELESCOPE_DB.prepare(
          'UPDATE telescope_agents SET status = ? WHERE id = ?',
        )
          .bind(state, id)
          .run();
        return json({ success: true });
      }
      return json({ error: 'Method not allowed' }, 405);
    }
    const agent = await authenticate(context);
    if (!agent) return json({ error: 'Invalid agent credential' }, 401);
    if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (action === 'register') {
      const parsed = Session.extend({
        protocolVersion: z.literal(1),
        capabilities: z
          .object({
            browsers: z.array(Browser).max(7),
            platform: z.string().max(100),
            architecture: z.string().max(50),
            version: z.string().max(100),
            allowHosts: z.array(z.string().max(255)).max(100),
          })
          .passthrough(),
      }).parse(await body(context));
      const changed = await env.TELESCOPE_DB.prepare(
        'UPDATE telescope_agents SET session_id = ?, capabilities_json = ?, last_seen = ? WHERE id = ? AND token_hash = ? AND status != ?',
      )
        .bind(
          parsed.sessionId,
          JSON.stringify(parsed.capabilities),
          Date.now(),
          agent.id,
          agent.token_hash,
          'revoked',
        )
        .run();
      if (!changed.meta.changes)
        return json({ error: 'Agent credential was revoked or rotated' }, 401);
      return json({
        protocolVersion: 1,
        leaseMs: LEASE_MS,
        maximumArchiveBytes: MAX_ZIP,
      });
    }
    if (action === 'ping') {
      const parsed = Session.parse(await body(context));
      if (parsed.sessionId !== agent.session_id)
        return json({ error: 'Stale session' }, 409);
      await env.TELESCOPE_DB.prepare(
        'UPDATE telescope_agents SET last_seen = ? WHERE id = ?',
      )
        .bind(Date.now(), agent.id)
        .run();
      return json({ success: true });
    }
    if (action === 'claim') {
      const parsed = Session.parse(await body(context));
      const current = await authenticate(context);
      if (!current || parsed.sessionId !== current.session_id)
        return json({ error: 'Stale session' }, 409);
      await reconcileAgentJobs();
      const now = Date.now();
      await env.TELESCOPE_DB.prepare(
        'UPDATE telescope_agents SET last_seen = ? WHERE id = ?',
      )
        .bind(now, agent.id)
        .run();
      if (agent.status !== 'active') return json({ job: null });
      const active = await env.TELESCOPE_DB.prepare(
        "SELECT id FROM telescope_attempts WHERE agent_id = ? AND lease_until > ? AND delivery_state != 'stored' AND execution_state NOT IN ('failed','cancelled','interrupted') LIMIT 1",
      )
        .bind(agent.id, now)
        .first();
      if (active) return json({ job: null });
      const attemptId = crypto.randomUUID();
      const leaseToken = crypto.randomUUID();
      const resultId = generateTestId(new Date(now).toISOString());
      await env.TELESCOPE_DB.batch([
        env.TELESCOPE_DB.prepare(
          "UPDATE telescope_jobs SET execution_state = 'claimed', delivery_state = 'not_started', active_attempt_id = ?, updated_at = ? WHERE id = (SELECT id FROM telescope_jobs WHERE agent_id = ? AND execution_state = 'queued' AND expires_at > ? ORDER BY created_at LIMIT 1) AND execution_state = 'queued' AND NOT EXISTS (SELECT 1 FROM telescope_attempts WHERE agent_id = ? AND lease_until > ? AND delivery_state NOT IN ('stored','unavailable')) AND EXISTS (SELECT 1 FROM telescope_agents WHERE id=? AND status='active' AND session_id=? AND token_hash=?)",
        ).bind(
          attemptId,
          now,
          agent.id,
          now,
          agent.id,
          now,
          agent.id,
          parsed.sessionId,
          agent.token_hash,
        ),
        env.TELESCOPE_DB.prepare(
          'INSERT INTO telescope_attempts (id,job_id,agent_id,session_id,lease_hash,lease_until,result_id,created_at,updated_at) SELECT ?,id,agent_id,?,?,?,?,?,? FROM telescope_jobs WHERE active_attempt_id = ?',
        ).bind(
          attemptId,
          parsed.sessionId,
          await hash(leaseToken),
          now + LEASE_MS,
          resultId,
          now,
          now,
          attemptId,
        ),
      ]);
      const job = await env.TELESCOPE_DB.prepare(
        'SELECT * FROM telescope_jobs WHERE active_attempt_id = ?',
      )
        .bind(attemptId)
        .first<JobRecord>();
      return json({
        job: job
          ? {
              id: job.id,
              attemptId,
              leaseToken,
              leaseUntil: now + LEASE_MS,
              resultId,
              options: await dispatchOptions(job),
            }
          : null,
      });
    }
    if (action === 'resume') {
      const parsed = Session.extend({
        attemptId: Id,
        leaseToken: z.string().uuid(),
        executionState: Terminal,
        coreTestId: z.string().max(100).optional(),
      }).parse(await body(context));
      const current = await authenticate(context);
      if (!current || parsed.sessionId !== current.session_id)
        return json({ error: 'Stale session' }, 409);
      const attempt = await env.TELESCOPE_DB.prepare(
        'SELECT a.* FROM telescope_attempts a JOIN telescope_jobs j ON j.active_attempt_id = a.id WHERE a.id = ? AND a.agent_id = ?',
      )
        .bind(parsed.attemptId, agent.id)
        .first<AttemptRecord>();
      if (
        !attempt ||
        !(await tokenMatches(await hash(parsed.leaseToken), attempt.lease_hash))
      )
        return json(
          { error: 'Attempt was superseded', code: 'superseded' },
          409,
        );
      if (attempt.receipt_json)
        return json({ receipt: JSON.parse(attempt.receipt_json) });
      const leaseToken = crypto.randomUUID();
      const now = Date.now();
      const nextLeaseHash = await hash(leaseToken);
      const resumed = await env.TELESCOPE_DB.batch([
        env.TELESCOPE_DB.prepare(
          "UPDATE telescope_attempts SET session_id = ?, lease_hash = ?, lease_until = ?, event_sequence = 0, execution_state = ?, delivery_state = 'uploading', delivery_error=NULL, core_test_id = ?, updated_at = ? WHERE id = ? AND lease_hash=? AND EXISTS (SELECT 1 FROM telescope_jobs WHERE id=job_id AND active_attempt_id=telescope_attempts.id) AND EXISTS (SELECT 1 FROM telescope_agents WHERE id=agent_id AND session_id=? AND token_hash=? AND status!='revoked')",
        ).bind(
          parsed.sessionId,
          nextLeaseHash,
          now + LEASE_MS,
          parsed.executionState,
          parsed.coreTestId ?? null,
          now,
          attempt.id,
          attempt.lease_hash,
          parsed.sessionId,
          agent.token_hash,
        ),
        env.TELESCOPE_DB.prepare(
          "UPDATE telescope_jobs SET execution_state = ?, delivery_state = 'uploading', delivery_error=NULL, updated_at = ? WHERE id = ? AND active_attempt_id = ? AND EXISTS (SELECT 1 FROM telescope_attempts WHERE id=? AND lease_hash=?)",
        ).bind(
          parsed.executionState,
          now,
          attempt.job_id,
          attempt.id,
          attempt.id,
          nextLeaseHash,
        ),
      ]);
      if (!resumed[0].meta.changes)
        return json(
          { error: 'Attempt was superseded', code: 'superseded' },
          409,
        );
      return json({ leaseToken, leaseUntil: now + LEASE_MS });
    }
    const attempt = await attemptFor(context, agent, action === 'receipt');
    if (!attempt)
      return json({ error: 'Invalid, expired, or superseded attempt' }, 409);
    if (action === 'receipt')
      return json({
        receipt: attempt.receipt_json ? JSON.parse(attempt.receipt_json) : null,
      });
    if (
      action === 'begin-files' ||
      action === 'upload-file' ||
      action === 'commit-files'
    ) {
      if (attempt.receipt_json)
        return json(
          action === 'begin-files'
            ? { ...JSON.parse(attempt.receipt_json), limits: {} }
            : { receipt: JSON.parse(attempt.receipt_json) },
        );
      if (
        !['passed', 'failed', 'cancelled', 'interrupted'].includes(
          attempt.execution_state,
        )
      )
        return json({ error: 'Capture must finish before delivery' }, 409);
      if (action === 'upload-file') {
        const transferId = context.request.headers.get('x-telescope-transfer');
        const filename = context.request.headers.get('x-telescope-artifact');
        if (!transferId || !filename)
          return json({ error: 'Missing transfer/artifact identity' }, 400);
        return json(
          await uploadAgentArtifact(context, {
            resultId: attempt.result_id,
            transferId,
            filename: decodeURIComponent(filename),
            request: context.request,
          }),
        );
      }
      if (action === 'begin-files') {
        const parsed = z
          .object({
            files: z.record(
              z.string(),
              z.object({
                size: z.number().int().nonnegative(),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
              }),
            ),
            coreTestId: z.string().optional(),
            executionState: Terminal,
          })
          .parse(await body(context, 2 * 1024 * 1024));
        if (parsed.executionState !== attempt.execution_state)
          return json(
            { error: 'Execution outcome does not match the assigned attempt' },
            409,
          );
        if (!(await attemptFor(context, agent)))
          return json(
            { error: 'Attempt expired while receiving manifest' },
            409,
          );
        const job = await env.TELESCOPE_DB.prepare(
          'SELECT * FROM telescope_jobs WHERE id = ?',
        )
          .bind(attempt.job_id)
          .first<JobRecord>();
        if (!job) return json({ error: 'Job not found' }, 404);
        const started = await beginAgentTransfer(context, {
          resultId: attempt.result_id,
          coreTestId: parsed.coreTestId ?? attempt.core_test_id ?? undefined,
          metadata: {
            source: TestSource.AGENT,
            name: job.name ?? undefined,
            description: job.description ?? undefined,
          },
          files: parsed.files,
          executionState: parsed.executionState,
          expectedUrl: String(JSON.parse(job.options_json).url),
        });
        await env.TELESCOPE_DB.batch([
          env.TELESCOPE_DB.prepare(
            "UPDATE telescope_attempts SET delivery_state='uploading' WHERE id=? AND lease_hash=? AND delivery_state != 'stored'",
          ).bind(attempt.id, attempt.lease_hash),
          env.TELESCOPE_DB.prepare(
            "UPDATE telescope_jobs SET delivery_state='uploading' WHERE id=? AND active_attempt_id=? AND delivery_state != 'stored'",
          ).bind(attempt.job_id, attempt.id),
        ]);
        if (started.stored)
          await storeReceipt(attempt, {
            testId: started.testId,
            resultId: started.resultId,
            stored: true,
            checksum: started.checksum,
          });
        return json(started);
      }
      const parsed = z
        .object({ transferId: z.string().min(1).max(200) })
        .parse(await body(context));
      const receipt = await commitAgentTransfer(context, {
        resultId: attempt.result_id,
        transferId: parsed.transferId,
        commitGuard: {
          jobId: attempt.job_id,
          attemptId: attempt.id,
          agentId: agent.id,
          sessionId: attempt.session_id,
          leaseHash: attempt.lease_hash,
        },
        beforeCommit: async () => {
          if (!(await attemptFor(context, agent)))
            throw new Error('Attempt expired before publication');
        },
      });
      const output = {
        testId: receipt.testId,
        resultId: receipt.resultId,
        coreTestId: attempt.core_test_id,
        stored: true as const,
        checksum: receipt.checksum,
      };
      await storeReceipt(attempt, output);
      return json({ receipt: output });
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
          coreTestId: z.string().max(100).optional(),
          progress: z.record(z.string(), z.unknown()).optional(),
          error: z.string().max(2048).optional(),
          deliveryError: z.string().max(2048).optional(),
          noArtifacts: z.boolean().optional(),
        })
        .parse(await body(context));
      if (!(await attemptFor(context, agent)))
        return json({ error: 'Attempt expired while receiving event' }, 409);
      const now = Date.now();
      const state = parsed.executionState ?? attempt.execution_state;
      await env.TELESCOPE_DB.batch([
        env.TELESCOPE_DB.prepare(
          "UPDATE telescope_attempts SET lease_until = ?, execution_state = CASE WHEN execution_state IN ('passed','failed','cancelled','interrupted') THEN execution_state ELSE ? END, event_sequence = ?, progress_json = COALESCE(?,progress_json), core_test_id = COALESCE(?,core_test_id), error = COALESCE(?,error), delivery_error=COALESCE(?,delivery_error), delivery_state = CASE WHEN ? THEN 'unavailable' WHEN ? IS NOT NULL THEN 'failed' ELSE delivery_state END, updated_at = ? WHERE id = ? AND event_sequence < ? AND lease_hash = ? AND EXISTS (SELECT 1 FROM telescope_jobs WHERE active_attempt_id=telescope_attempts.id AND id=telescope_attempts.job_id) AND EXISTS (SELECT 1 FROM telescope_agents WHERE id=telescope_attempts.agent_id AND status!='revoked' AND session_id=? AND token_hash=?)",
        ).bind(
          now + LEASE_MS,
          state,
          parsed.sequence,
          parsed.progress ? JSON.stringify(parsed.progress) : null,
          parsed.coreTestId ?? null,
          parsed.error ?? null,
          parsed.deliveryError ?? null,
          parsed.noArtifacts ? 1 : 0,
          parsed.deliveryError ?? null,
          now,
          attempt.id,
          parsed.sequence,
          attempt.lease_hash,
          attempt.session_id,
          agent.token_hash,
        ),
        env.TELESCOPE_DB.prepare(
          'UPDATE telescope_agents SET last_seen = ? WHERE id = ?',
        ).bind(now, agent.id),
        env.TELESCOPE_DB.prepare(
          'UPDATE telescope_jobs SET execution_state = (SELECT execution_state FROM telescope_attempts WHERE id = ?), delivery_state = (SELECT delivery_state FROM telescope_attempts WHERE id = ?), error = (SELECT error FROM telescope_attempts WHERE id = ?), delivery_error=(SELECT delivery_error FROM telescope_attempts WHERE id=?), updated_at = ? WHERE id = ? AND active_attempt_id = ?',
        ).bind(
          attempt.id,
          attempt.id,
          attempt.id,
          attempt.id,
          now,
          attempt.job_id,
          attempt.id,
        ),
      ]);
      const job = await env.TELESCOPE_DB.prepare(
        'SELECT cancel_requested FROM telescope_jobs WHERE id = ?',
      )
        .bind(attempt.job_id)
        .first<{ cancel_requested: number }>();
      const renewed = await env.TELESCOPE_DB.prepare(
        'SELECT lease_until FROM telescope_attempts WHERE id = ?',
      )
        .bind(attempt.id)
        .first<{ lease_until: number }>();
      return json({
        leaseUntil: renewed?.lease_until ?? attempt.lease_until,
        cancelRequested: Boolean(job?.cancel_requested),
      });
    }
    if (action === 'upload') {
      if (attempt.receipt_json)
        return json({ receipt: JSON.parse(attempt.receipt_json) });
      if (
        !['passed', 'failed', 'cancelled', 'interrupted'].includes(
          attempt.execution_state,
        )
      )
        return json({ error: 'Capture must finish before delivery' }, 409);
      const archive = await readBounded(context.request, MAX_ZIP);
      if (!(await attemptFor(context, agent)))
        return json({ error: 'Attempt expired while receiving archive' }, 409);
      const job = await env.TELESCOPE_DB.prepare(
        'SELECT * FROM telescope_jobs WHERE id = ?',
      )
        .bind(attempt.job_id)
        .first<JobRecord>();
      if (!job) return json({ error: 'Job not found' }, 404);
      const parsedArchive = await parseResultArchive(archive);
      if (parsedArchive.config.url !== String(JSON.parse(job.options_json).url))
        return json({ error: 'Capture URL does not match assigned job' }, 409);
      await env.TELESCOPE_DB.prepare(
        "UPDATE telescope_attempts SET delivery_state = 'uploading' WHERE id = ? AND lease_hash = ?",
      )
        .bind(attempt.id, attempt.lease_hash)
        .run();
      const receipt = await ingestResultArchive(context, archive, {
        resultId: attempt.result_id,
        coreTestId: attempt.core_test_id ?? undefined,
        metadata: {
          source: TestSource.AGENT,
          name: job.name ?? undefined,
          description: job.description ?? undefined,
        },
        visibility: 'private',
        commitGuard: {
          jobId: attempt.job_id,
          attemptId: attempt.id,
          agentId: agent.id,
          sessionId: attempt.session_id,
          leaseHash: attempt.lease_hash,
        },
        beforeCommit: async () => {
          if (!(await attemptFor(context, agent)))
            throw new Error('Attempt expired before publication');
        },
      });
      const output = {
        testId: receipt.testId,
        resultId: receipt.testId,
        coreTestId: attempt.core_test_id,
        checksum: receipt.zipKey,
        stored: true as const,
      };
      await storeReceipt(attempt, output);
      return json({ receipt: output });
    }
    return json({ error: 'Unknown agent action' }, 404);
  } catch (error) {
    const status = error instanceof IngestionError ? error.status : 400;
    return json(
      {
        error: error instanceof Error ? error.message : 'Agent request failed',
      },
      status,
    );
  }
}

/** Authenticated browser-facing durable job submission/status/cancellation API. */
export async function handleRuns(context: APIContext): Promise<Response> {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  try {
    await reconcileAgentJobs();
    const action = context.params.action ?? '';
    const [id, verb] = action.split('/');
    const method = context.request.method;
    if (!action && method === 'GET') {
      const records = await env.TELESCOPE_DB.prepare(
        'SELECT j.*,a.name AS agent_name FROM telescope_jobs j JOIN telescope_agents a ON a.id=j.agent_id ORDER BY j.created_at DESC LIMIT 100',
      ).all<JobRecord>();
      return json({
        jobs: records.results.map(job => ({
          ...job,
          options_json: undefined,
          secrets_json: undefined,
          request_hash: undefined,
          idempotency_key: undefined,
        })),
      });
    }
    if (!action && method === 'POST') {
      const parsed = z
        .object({
          agentId: Id,
          name: z.string().max(200).optional(),
          description: z.string().max(4000).optional(),
          options: Config,
        })
        .parse(await body(context));
      const key = context.request.headers.get('idempotency-key');
      if (!key || key.length > 200)
        return json({ error: 'A bounded Idempotency-Key is required' }, 400);
      const requestHash = await hash(JSON.stringify(parsed));
      const old = await env.TELESCOPE_DB.prepare(
        'SELECT * FROM telescope_jobs WHERE idempotency_key = ?',
      )
        .bind(key)
        .first<JobRecord>();
      if (old)
        return old.request_hash === requestHash
          ? json({ jobId: old.id, duplicate: true })
          : json({ error: 'Idempotency key is bound to another request' }, 409);
      const agent = await env.TELESCOPE_DB.prepare(
        "SELECT * FROM telescope_agents WHERE id=? AND status='active'",
      )
        .bind(parsed.agentId)
        .first<AgentRecord>();
      if (!agent)
        return json({ error: 'Agent is unavailable or disabled' }, 400);
      const capabilities = z
        .object({
          browsers: z.array(Browser),
          devices: z.array(z.string()).optional(),
          deviceBrowsers: z.record(z.string(), Browser).optional(),
          throttling: z.boolean().optional(),
          scripts: z
            .array(
              z.object({ id: z.string(), sha256: z.string() }).passthrough(),
            )
            .optional(),
        })
        .passthrough()
        .safeParse(JSON.parse(agent.capabilities_json));
      if (!capabilities.success)
        return json(
          { error: 'Agent has not registered compatible capabilities' },
          400,
        );
      if (
        parsed.options.device &&
        !capabilities.data.devices?.includes(parsed.options.device)
      )
        return json(
          { error: 'Agent does not advertise the requested device' },
          400,
        );
      const browser =
        parsed.options.browser ??
        (parsed.options.device
          ? capabilities.data.deviceBrowsers?.[parsed.options.device]
          : undefined) ??
        DEFAULT_OPTIONS.browser;
      if (!capabilities.data.browsers.includes(browser))
        return json(
          {
            error:
              'Agent does not advertise the requested browser; select an installed browser explicitly',
          },
          400,
        );
      parsed.options.browser = browser;
      if (parsed.options.connectionType && !capabilities.data.throttling)
        return json(
          { error: 'Agent does not advertise network throttling support' },
          400,
        );
      if (
        parsed.options.cpuThrottle &&
        !['chrome', 'chrome-beta', 'chromium', 'canary', 'edge'].includes(
          browser,
        )
      )
        return json(
          { error: 'CPU throttling requires a Chromium browser' },
          400,
        );
      if (
        parsed.options.scriptId &&
        !capabilities.data.scripts?.some(
          script =>
            script.id === parsed.options.scriptId &&
            script.sha256 === parsed.options.scriptHash,
        )
      )
        return json(
          {
            error:
              'Agent does not advertise the requested trusted script version',
          },
          400,
        );
      const protectedOptions = await protectOptions(parsed.options);
      const now = Date.now();
      const jobId = crypto.randomUUID();
      try {
        await env.TELESCOPE_DB.prepare(
          'INSERT INTO telescope_jobs (id,agent_id,name,description,options_json,secrets_json,request_hash,idempotency_key,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
          .bind(
            jobId,
            agent.id,
            parsed.name ?? null,
            parsed.description ?? null,
            JSON.stringify(protectedOptions.options),
            protectedOptions.secrets,
            requestHash,
            key,
            now,
            now,
            now + 24 * 60 * 60 * 1000,
          )
          .run();
      } catch (error) {
        const duplicate = await env.TELESCOPE_DB.prepare(
          'SELECT * FROM telescope_jobs WHERE idempotency_key = ?',
        )
          .bind(key)
          .first<JobRecord>();
        if (duplicate?.request_hash === requestHash)
          return json({ jobId: duplicate.id, duplicate: true });
        throw error;
      }
      return json({ jobId, url: `/runs/${jobId}` }, 202);
    }
    if (!Id.safeParse(id).success)
      return json({ error: 'Invalid job ID' }, 400);
    const job = await env.TELESCOPE_DB.prepare(
      'SELECT * FROM telescope_jobs WHERE id = ?',
    )
      .bind(id)
      .first<JobRecord>();
    if (!job) return json({ error: 'Job not found' }, 404);
    if (!verb && method === 'GET') {
      const attempts = await env.TELESCOPE_DB.prepare(
        'SELECT * FROM telescope_attempts WHERE job_id = ? ORDER BY created_at',
      )
        .bind(id)
        .all<AttemptRecord>();
      return json({
        job: {
          ...job,
          options_json: undefined,
          secrets_json: undefined,
          request_hash: undefined,
          idempotency_key: undefined,
        },
        attempts: attempts.results.map(item => ({
          ...item,
          lease_hash: undefined,
          session_id: undefined,
          progress: item.progress_json ? JSON.parse(item.progress_json) : null,
          receipt: item.receipt_json ? JSON.parse(item.receipt_json) : null,
        })),
      });
    }
    if (verb === 'cancel' && method === 'POST') {
      const now = Date.now();
      await env.TELESCOPE_DB.prepare(
        "UPDATE telescope_jobs SET cancel_requested = 1, execution_state = CASE WHEN execution_state = 'queued' THEN 'cancelled' ELSE execution_state END, updated_at = ? WHERE id = ? AND execution_state NOT IN ('passed','failed','cancelled','interrupted')",
      )
        .bind(now, id)
        .run();
      return json({ success: true });
    }
    if (verb === 'retry' && method === 'POST') {
      const result = await env.TELESCOPE_DB.prepare(
        "UPDATE telescope_jobs SET execution_state='queued',delivery_state='not_started',active_attempt_id=NULL,cancel_requested=0,error=NULL,updated_at=?,expires_at=? WHERE id=? AND execution_state IN ('failed','cancelled','interrupted')",
      )
        .bind(Date.now(), Date.now() + 24 * 60 * 60 * 1000, id)
        .run();
      return result.meta.changes
        ? json({ success: true, jobId: id })
        : json(
            { error: 'Only terminal failed/interrupted jobs can be retried' },
            409,
          );
    }
    return json({ error: 'Method or action not allowed' }, 405);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Job request failed' },
      400,
    );
  }
}
