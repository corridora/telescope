import { env } from 'cloudflare:workers';

import type { APIRoute } from 'astro';

import { getBindingString, requireAdmin, tokenMatches } from '@/lib/auth';
import {
  controlForwarding,
  forwardingEnabled,
  forwardingHistory,
  forwardingSummary,
  listForwarding,
  processForwarding,
} from '@/lib/forwarding/service';

const RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: RESPONSE_HEADERS });
}

async function smallJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new Error('Forwarding control requests must not exceed 4 KiB');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(output));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

/** Public upload disclosure; no endpoint, credentials or private delivery data. */
export const GET: APIRoute = async context => {
  const action = context.params.action;
  if (action === 'status') {
    return json({
      enabled: forwardingEnabled(env),
      destinationLabel: forwardingEnabled(env)
        ? (getBindingString(env, 'UPLOAD_FORWARD_LABEL') ??
          'Configured destination')
        : null,
      originalArchive: true,
    });
  }
  const rejected = await requireAdmin(context);
  if (rejected) return rejected;
  try {
    if (action === 'list') {
      const testId = context.url.searchParams.get('testId') ?? undefined;
      if (testId && !/^[a-zA-Z0-9_-]{1,128}$/.test(testId))
        return json({ error: 'Invalid result ID' }, 400);
      return json({ deliveries: await listForwarding(env, testId) });
    }
    if (action === 'history') {
      const id = context.url.searchParams.get('deliveryId');
      if (!id || !/^[a-f0-9-]{36}$/.test(id))
        return json({ error: 'Invalid delivery ID' }, 400);
      return json({ attempts: await forwardingHistory(id, env) });
    }
    if (action === 'summary')
      return json({ states: await forwardingSummary(env) });
    return json({ error: 'Unknown forwarding endpoint' }, 404);
  } catch {
    return json(
      {
        error:
          'Forwarding state is unavailable. Apply migration 0005 and check instance storage.',
      },
      503,
    );
  }
};

/** Admin controls; a separately scoped scheduler token can only process due work. */
export const POST: APIRoute = async context => {
  const action = context.params.action;
  let scheduler = false;
  if (action === 'process') {
    const expected = getBindingString(env, 'UPLOAD_FORWARD_SCHEDULER_TOKEN');
    const authorization = context.request.headers.get('Authorization');
    scheduler =
      !!expected &&
      !!authorization?.startsWith('Bearer ') &&
      (await tokenMatches(authorization.slice(7), expected));
  }
  if (!scheduler) {
    const rejected = await requireAdmin(context);
    if (rejected) return rejected;
  }
  try {
    if (action === 'process')
      return json(await processForwarding(context, env));
    if (!['retry', 'pause', 'resume', 'cancel'].includes(action ?? '')) {
      return json({ error: 'Unknown forwarding action' }, 404);
    }
    const body = await smallJson(context.request);
    if (
      typeof body.deliveryId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(body.deliveryId)
    ) {
      return json({ error: 'Invalid delivery ID' }, 400);
    }
    const delivery = await controlForwarding(
      body.deliveryId,
      action as 'retry' | 'pause' | 'resume' | 'cancel',
      env,
    );
    return json({ delivery });
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
};
