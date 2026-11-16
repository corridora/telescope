import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { SQLInputValue } from 'node:sqlite';
import type { APIContext } from 'astro';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bindings = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => ({ env: bindings.env }));

import { handleAgents } from '@/lib/agents/controller';

const ORIGIN = 'https://telescope.example';
const ADMIN = 'hosted-agent-test-administrator';
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Execute the controller's real SQL against SQLite using the D1 method surface. */
function createD1(database: DatabaseSync) {
  function prepare(sql: string, parameters: SQLInputValue[] = []) {
    const execute = () => {
      const result = database.prepare(sql).run(...parameters);
      return {
        success: true,
        results: [],
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid),
        },
      };
    };
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      first: async <T>() =>
        (database.prepare(sql).get(...parameters) as T | undefined) ?? null,
      all: async <T>() => ({
        success: true,
        results: database.prepare(sql).all(...parameters) as T[],
        meta: {},
      }),
      run: async () => execute(),
      execute,
    };
  }
  return {
    prepare,
    batch: async (statements: Array<ReturnType<typeof prepare>>) => {
      database.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

describe('Hosted agent credential fencing with real SQLite', () => {
  let database: DatabaseSync;
  let agentId: string;
  let token: string;
  let sessionId: string;
  let jobId: string;
  let attemptId: string;
  let leaseToken: string;

  function context(action: string, request: Request): APIContext {
    return { request, params: { action } } as APIContext;
  }

  async function admin(action: string): Promise<Response> {
    return handleAgents(
      context(
        action,
        new Request(`${ORIGIN}/api/agents/${action}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ADMIN}`,
            Origin: ORIGIN,
            'Content-Type': 'application/json',
          },
          body: '{}',
        }),
      ),
    );
  }

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      fs.readFileSync(
        new URL('../migrations/0004_external_agents.sql', import.meta.url),
        'utf8',
      ),
    );
    agentId = randomUUID();
    token = `${agentId}.${randomUUID()}${randomUUID()}`;
    sessionId = randomUUID();
    jobId = randomUUID();
    attemptId = randomUUID();
    leaseToken = randomUUID();
    const now = Date.now();
    database
      .prepare(
        'INSERT INTO telescope_agents (id,name,token_hash,status,session_id,last_seen,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        agentId,
        'Runner',
        digest(token),
        'active',
        sessionId,
        now - 10_000,
        now,
      );
    database
      .prepare(
        'INSERT INTO telescope_jobs (id,agent_id,options_json,request_hash,idempotency_key,execution_state,active_attempt_id,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        jobId,
        agentId,
        JSON.stringify({ url: 'https://app.internal', browser: 'chromium' }),
        'fixture',
        randomUUID(),
        'claimed',
        attemptId,
        now,
        now,
        now + 60_000,
      );
    database
      .prepare(
        'INSERT INTO telescope_attempts (id,job_id,agent_id,session_id,lease_hash,lease_until,result_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        attemptId,
        jobId,
        agentId,
        sessionId,
        digest(leaseToken),
        now + 90_000,
        `2026_11_16_12_00_00_${randomUUID()}`,
        now,
        now,
      );
    bindings.env.TELESCOPE_DB = createD1(database);
    bindings.env.TELESCOPE_ADMIN_TOKEN = ADMIN;
  });

  afterEach(() => {
    database.close();
    delete bindings.env.TELESCOPE_DB;
    delete bindings.env.TELESCOPE_ADMIN_TOKEN;
  });

  it.each(
    ['register', 'ping', 'claim', 'resume', 'event'].flatMap(action =>
      ['revoke', 'rotate'].map(mutation => ({ action, mutation })),
    ),
  )(
    'rejects $action when credentials $mutation while the body arrives',
    async ({ action, mutation }) => {
      const payload =
        action === 'register'
          ? {
              protocolVersion: 1,
              sessionId: randomUUID(),
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
                sessionId,
                attemptId,
                leaseToken,
                executionState: 'passed',
              }
            : action === 'event'
              ? {
                  sequence: 1,
                  executionState: 'passed',
                }
              : { sessionId };
      let bodyStarted: (() => void) | undefined;
      const started = new Promise<void>(resolve => {
        bodyStarted = resolve;
      });
      let releaseBody: (() => void) | undefined;
      const released = new Promise<void>(resolve => {
        releaseBody = resolve;
      });
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            bodyStarted!();
            await released;
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(payload)),
            );
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        duplex: 'half',
        body: stream,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Telescope-Session': sessionId,
          'X-Telescope-Attempt': attemptId,
          'X-Telescope-Lease': leaseToken,
        },
      };
      const pending = handleAgents(
        context(action, new Request(`${ORIGIN}/api/agents/${action}`, init)),
      );
      await started;
      expect((await admin(`${agentId}/${mutation}`)).status).toBe(200);
      const protectedAgent = database
        .prepare(
          'SELECT status,session_id,token_hash,last_seen FROM telescope_agents WHERE id=?',
        )
        .get(agentId);
      const protectedAttempt = database
        .prepare(
          'SELECT session_id,lease_hash,lease_until,execution_state,event_sequence FROM telescope_attempts WHERE id=?',
        )
        .get(attemptId);
      releaseBody!();
      const response = await pending;
      expect([401, 409]).toContain(response.status);
      expect(
        database
          .prepare(
            'SELECT status,session_id,token_hash,last_seen FROM telescope_agents WHERE id=?',
          )
          .get(agentId),
      ).toEqual(protectedAgent);
      expect(
        database
          .prepare(
            'SELECT session_id,lease_hash,lease_until,execution_state,event_sequence FROM telescope_attempts WHERE id=?',
          )
          .get(attemptId),
      ).toEqual(protectedAttempt);
      expect(
        database
          .prepare('SELECT execution_state FROM telescope_jobs WHERE id=?')
          .get(jobId),
      ).toEqual({ execution_state: 'claimed' });
    },
  );
});
