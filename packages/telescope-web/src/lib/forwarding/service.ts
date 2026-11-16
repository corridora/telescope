import { env } from 'cloudflare:workers';

import { getBindingString } from '@/lib/auth';

import {
  forwardingEnabled,
  getForwardingConfiguration,
  validateForwardingDestination,
} from './config';
import type {
  ForwardingConfiguration,
  ForwardingAttempt,
  ForwardingDelivery,
  ForwardingDeliveryRow,
  ForwardingProcessResult,
  ForwardingReceipt,
  ForwardMetadata,
  ForwardProvenance,
  ForwardUploadReceipt,
} from './types';

const TABLE = 'upload_forward_deliveries';
const TERMINAL = "'accepted','blocked','expired','failed','cancelled'";
const UNSENT = "'waiting_review','pending','retrying','paused'";
const encode = new TextEncoder();

class DeliveryFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status: number | null = null,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'DeliveryFailure';
  }
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function jsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function snapshot(row: ForwardingDeliveryRow): ForwardingConfiguration {
  return JSON.parse(row.settings_json) as ForwardingConfiguration;
}

function safeReceipt(value: string | null): ForwardingReceipt | null {
  if (!value) return null;
  try {
    const parsed = jsonRecord(value);
    if (parsed.accepted !== true || typeof parsed.status !== 'number')
      return null;
    const receipt: ForwardingReceipt = {
      status: parsed.status,
      accepted: true,
      durableStorageConfirmed: parsed.durableStorageConfirmed === true,
    };
    if (typeof parsed.remoteTestId === 'string')
      receipt.remoteTestId = parsed.remoteTestId;
    if (typeof parsed.remoteResultUrl === 'string')
      receipt.remoteResultUrl = parsed.remoteResultUrl;
    return receipt;
  } catch {
    return null;
  }
}

/** Return safe delivery metadata; never expose stored endpoints, headers or ZIP keys. */
export function describeForwarding(
  row: ForwardingDeliveryRow,
): ForwardingDelivery {
  return {
    deliveryId: row.delivery_id,
    testId: row.test_id,
    destinationLabel: row.destination_label,
    state: row.state,
    attemptCount: row.attempt_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    nextAttemptAt: ['pending', 'retrying'].includes(row.state)
      ? iso(row.next_attempt_at)
      : null,
    sourceExpiresAt: iso(row.source_expires_at),
    lastStatus: row.last_status,
    error: row.last_error,
    receipt: safeReceipt(row.receipt_json),
    retryAvailable:
      !row.archive_deleted_at &&
      row.source_expires_at > Date.now() &&
      !['accepted', 'sending', 'blocked', 'expired'].includes(row.state),
    cancellationRequested: row.cancel_requested === 1,
  };
}

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encode.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encode.encode(text));
  return Array.from(new Uint8Array(signature), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Verify cooperating-peer provenance; arbitrary browser headers cannot suppress sends. */
export async function trustedForwardProvenance(
  request: Request,
  archiveSha256: string,
  bindings: object = env,
): Promise<ForwardProvenance> {
  const empty = { trusted: false, chain: [] };
  const secret = getBindingString(bindings, 'UPLOAD_FORWARD_PEER_SECRET');
  const deliveryId = request.headers.get('X-Telescope-Forward-Id');
  const chain = request.headers.get('X-Telescope-Forward-Chain');
  const signature = request.headers.get('X-Telescope-Forward-Signature');
  if (
    !secret ||
    !deliveryId ||
    !chain ||
    !signature ||
    !/^[a-f0-9-]{36}$/.test(deliveryId) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return empty;
  const instances = chain.split(',');
  if (
    instances.length > 8 ||
    instances.some(id => !/^[a-zA-Z0-9_-]{8,128}$/.test(id))
  )
    return empty;
  const key = await crypto.subtle.importKey(
    'raw',
    encode.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signatureBytes = Uint8Array.from(signature.match(/../g)!, byte =>
    parseInt(byte, 16),
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encode.encode(`${deliveryId}\n${archiveSha256}\n${chain}`),
  );
  return valid ? { trusted: true, chain: instances } : empty;
}

/** Persist one forwarding intent before local publication; sends require committed data. */
export async function scheduleForward(
  context: { request: Request },
  receipt: ForwardUploadReceipt,
  metadata: ForwardMetadata,
  provenance?: ForwardProvenance,
  bindings: typeof env = env,
): Promise<ForwardingDelivery | null> {
  const config = await getForwardingConfiguration(
    bindings,
    new URL(context.request.url).origin,
  );
  if (!config) return null;
  const previous = await bindings.TELESCOPE_DB.prepare(
    `SELECT * FROM ${TABLE} WHERE test_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(receipt.testId)
    .first<ForwardingDeliveryRow>();
  if (receipt.duplicate) return previous ? describeForwarding(previous) : null;
  const origin =
    provenance ??
    (await trustedForwardProvenance(context.request, receipt.zipKey, bindings));
  // Forwarded archives are accepted locally, but are not automatically relayed again.
  if (origin.trusted) return null;
  if (!receipt.originalZipKey || !/^[a-f0-9]{64}$/.test(receipt.zipKey)) {
    throw new Error(
      'Forwarding requires the retained original ZIP and its checksum',
    );
  }
  const original = await bindings.RESULTS_BUCKET.head(receipt.originalZipKey);
  if (!original) throw new Error('The original ZIP is not durably stored');
  if (original.size > config.maxArchiveBytes)
    throw new Error('The ZIP exceeds the forwarding size limit');
  const filename =
    (metadata.filename ?? `${receipt.testId}.zip`)
      .split(/[\\/]/)
      .pop()!
      .replace(/[\x00-\x1f\x7f"]/g, '_')
      .slice(0, 180) || 'result.zip';
  const safeMetadata: ForwardMetadata = {
    source: /^[a-z]{1,32}$/.test(metadata.source) ? metadata.source : 'upload',
    ...(metadata.name ? { name: metadata.name.slice(0, 256) } : {}),
    ...(metadata.description
      ? { description: metadata.description.slice(0, 10_000) }
      : {}),
  };
  const now = Date.now();
  const id = crypto.randomUUID();
  const state = config.requireReview
    ? receipt.contentRating === 'safe'
      ? 'pending'
      : receipt.contentRating === 'unsafe'
        ? 'blocked'
        : 'waiting_review'
    : 'pending';
  const inserted = await bindings.TELESCOPE_DB.prepare(
    `INSERT OR IGNORE INTO ${TABLE}
      (delivery_id, test_id, archive_key, archive_sha256, archive_size, filename,
       metadata_json, destination_url, destination_label, config_version, settings_json,
       instance_chain, state, created_at, updated_at, next_attempt_at, source_expires_at, terminal_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
     WHERE (SELECT COALESCE(SUM(archive_size),0) FROM ${TABLE} WHERE archive_deleted_at IS NULL) + ? <= ?`,
  )
    .bind(
      id,
      receipt.testId,
      receipt.originalZipKey,
      receipt.zipKey,
      original.size,
      filename,
      JSON.stringify(safeMetadata),
      config.destinationUrl,
      config.destinationLabel,
      config.version,
      JSON.stringify(config),
      JSON.stringify([config.instanceId]),
      state,
      now,
      now,
      now,
      now + config.maxAgeMs,
      state === 'blocked' ? now : null,
      original.size,
      config.maxSpoolBytes,
    )
    .run();
  if (!inserted.meta.changes) {
    const existing = await bindings.TELESCOPE_DB.prepare(
      `SELECT * FROM ${TABLE} WHERE test_id = ? AND config_version = ?`,
    )
      .bind(receipt.testId, config.version)
      .first<ForwardingDeliveryRow>();
    if (existing) return describeForwarding(existing);
    throw new Error(
      'The retained forwarding spool is full; forwarding was not scheduled',
    );
  }
  const row = await bindings.TELESCOPE_DB.prepare(
    `SELECT * FROM ${TABLE} WHERE delivery_id = ?`,
  )
    .bind(id)
    .first<ForwardingDeliveryRow>();
  if (!row)
    throw new Error('Forwarding intent could not be read after storage');
  return describeForwarding(row);
}

/** Read delivery history without exposing outbound secrets or storage locations. */
export async function listForwarding(
  bindings: typeof env = env,
  testId?: string,
  limit = 100,
): Promise<ForwardingDelivery[]> {
  const rows = await bindings.TELESCOPE_DB.prepare(
    `SELECT * FROM ${TABLE} ${testId ? 'WHERE test_id = ?' : ''}
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...(testId ? [testId, Math.min(200, limit)] : [Math.min(200, limit)]))
    .all<ForwardingDeliveryRow>();
  return rows.results.map(describeForwarding);
}

/** Read the bounded, persistent attempt history for one delivery. */
export async function forwardingHistory(
  deliveryId: string,
  bindings: typeof env = env,
): Promise<ForwardingAttempt[]> {
  const rows = await bindings.TELESCOPE_DB.prepare(
    `SELECT * FROM upload_forward_attempts WHERE delivery_id = ? ORDER BY sequence DESC LIMIT 100`,
  )
    .bind(deliveryId)
    .all<{
      attempt_id: string;
      sequence: number;
      started_at: number;
      ended_at: number | null;
      outcome: string;
      status: number | null;
      error: string | null;
    }>();
  return rows.results.map(row => ({
    attemptId: row.attempt_id,
    sequence: row.sequence,
    startedAt: iso(row.started_at),
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    outcome: row.outcome,
    status: row.status,
    error: row.error,
  }));
}

async function reconcile(
  bindings: typeof env,
  enabled: boolean,
  version: string | null,
): Promise<void> {
  const now = Date.now();
  const database = bindings.TELESCOPE_DB;
  await database
    .prepare(
      `UPDATE upload_forward_attempts SET outcome = 'unknown', ended_at = ?,
       error = 'Transfer owner expired; the destination may already have accepted bytes'
     WHERE ended_at IS NULL AND attempt_id IN
       (SELECT lease_token FROM ${TABLE} WHERE state = 'sending' AND lease_expires_at <= ?)`,
    )
    .bind(now, now)
    .run();
  await database
    .prepare(
      `UPDATE ${TABLE} SET state = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'retrying' END,
       lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?,
       terminal_at = CASE WHEN cancel_requested = 1 THEN ? ELSE NULL END,
       last_error = 'Previous transfer owner stopped before acknowledging its outcome; a receiver may already have accepted bytes'
     WHERE state = 'sending' AND lease_expires_at <= ?`,
    )
    .bind(now, now, now, now)
    .run();
  await database
    .prepare(
      `UPDATE ${TABLE} SET state = 'expired', terminal_at = ?, updated_at = ?,
       lease_token = NULL, lease_expires_at = NULL, last_error = 'Original ZIP retention deadline expired'
     WHERE state IN (${UNSENT}) AND source_expires_at <= ?`,
    )
    .bind(now, now, now)
    .run();
  await database
    .prepare(
      `UPDATE ${TABLE} SET state = 'cancelled', terminal_at = ?, updated_at = ?,
       last_error = 'Local result was removed before delivery'
     WHERE state IN (${UNSENT}) AND NOT EXISTS
       (SELECT 1 FROM tests WHERE tests.test_id = ${TABLE}.test_id)`,
    )
    .bind(now, now)
    .run();
  const candidates = await database
    .prepare(
      `SELECT f.*, t.content_rating FROM ${TABLE} f JOIN tests t ON t.test_id = f.test_id
     WHERE f.state IN ('waiting_review','pending','retrying') AND t.publication_state = 'committed'
     LIMIT 100`,
    )
    .all<ForwardingDeliveryRow & { content_rating: string }>();
  for (const row of candidates.results) {
    const config = snapshot(row);
    let state = row.state;
    let error: string | null = null;
    if (!enabled || row.config_version !== version) {
      state = 'paused';
      error = !enabled
        ? 'Forwarding is disabled; an administrator must resume this delivery'
        : 'Destination configuration changed; restore its version or explicitly create a new delivery';
    } else if (config.requireReview && row.content_rating === 'unsafe') {
      state = 'blocked';
      error =
        'Instance content review restricted this result; it was not forwarded';
    } else if (config.requireReview && row.content_rating !== 'safe') {
      state = 'waiting_review';
    } else if (state === 'waiting_review') {
      state = 'pending';
    }
    if (state !== row.state || error) {
      await database
        .prepare(
          `UPDATE ${TABLE} SET state = ?, last_error = ?, updated_at = ?, terminal_at = ?
         WHERE delivery_id = ? AND state = ?`,
        )
        .bind(
          state,
          error,
          now,
          state === 'blocked' ? now : null,
          row.delivery_id,
          row.state,
        )
        .run();
    }
  }
}

/** Delete only unreferenced terminal source ZIPs; capture artifacts are never removed. */
export async function cleanupForwarding(
  bindings: typeof env = env,
): Promise<void> {
  const now = Date.now();
  const rows = await bindings.TELESCOPE_DB.prepare(
    `SELECT * FROM ${TABLE} WHERE state IN (${TERMINAL}) AND archive_deleted_at IS NULL
     AND terminal_at IS NOT NULL ORDER BY terminal_at LIMIT 100`,
  ).all<ForwardingDeliveryRow>();
  for (const row of rows.results) {
    const config = snapshot(row);
    const retention =
      row.state === 'accepted'
        ? config.acceptedRetentionMs
        : config.terminalRetentionMs;
    if (row.terminal_at! + retention > now) continue;
    const other = await bindings.TELESCOPE_DB.prepare(
      `SELECT delivery_id FROM ${TABLE} WHERE archive_key = ? AND delivery_id != ?
       AND archive_deleted_at IS NULL AND state NOT IN (${TERMINAL}) LIMIT 1`,
    )
      .bind(row.archive_key, row.delivery_id)
      .first();
    if (other) continue;
    await bindings.RESULTS_BUCKET.delete(row.archive_key);
    await bindings.TELESCOPE_DB.prepare(
      `UPDATE ${TABLE} SET archive_deleted_at = ?, updated_at = ?
       WHERE archive_key = ? AND state IN (${TERMINAL}) AND archive_deleted_at IS NULL`,
    )
      .bind(now, now, row.archive_key)
      .run();
  }
}

function multipartBody(
  body: ReadableStream<Uint8Array>,
  row: ForwardingDeliveryRow,
): { body: ReadableStream<Uint8Array>; contentType: string; size: number } {
  const metadata = jsonRecord(row.metadata_json);
  const boundary = `telescope-${crypto.randomUUID()}`;
  const fields: string[] = [];
  for (const field of ['name', 'description', 'source']) {
    if (typeof metadata[field] === 'string') {
      fields.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${metadata[field]}\r\n`,
      );
    }
  }
  fields.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${row.filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const prefix = encode.encode(fields.join(''));
  const suffix = encode.encode(`\r\n--${boundary}--\r\n`);
  const reader = body.getReader();
  let phase = 0;
  return {
    size: prefix.byteLength + row.archive_size + suffix.byteLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (phase === 0) {
          phase = 1;
          controller.enqueue(prefix);
          return;
        }
        if (phase === 1) {
          const chunk = await reader.read();
          if (!chunk.done) {
            controller.enqueue(chunk.value);
            return;
          }
          phase = 2;
          reader.releaseLock();
          controller.enqueue(suffix);
          controller.close();
        }
      },
      async cancel(reason) {
        if (phase < 2) await reader.cancel(reason);
      },
    }),
  };
}

async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        throw new DeliveryFailure('Destination receipt exceeds 8 KiB');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(output);
}

function receiptFrom(
  response: Response,
  row: ForwardingDeliveryRow,
  text: string,
): ForwardingReceipt {
  let value: Record<string, unknown>;
  try {
    value = jsonRecord(text);
  } catch {
    throw new DeliveryFailure(
      'Destination did not return a valid Telescope receipt',
      false,
      response.status,
    );
  }
  const matches =
    value.zipKey === row.archive_sha256 ||
    value.sha256 === row.archive_sha256 ||
    value.archiveSha256 === row.archive_sha256 ||
    value.deliveryId === row.delivery_id;
  const accepted = response.ok && value.success === true;
  const duplicate = response.status === 409 && value.duplicate === true;
  if (!matches || !(accepted || duplicate)) {
    throw new DeliveryFailure(
      'Destination receipt did not confirm this archive/delivery',
      false,
      response.status,
    );
  }
  const receipt: ForwardingReceipt = {
    status: response.status,
    accepted: true,
    durableStorageConfirmed:
      value.publicationState === 'committed' && response.status !== 202,
  };
  if (
    typeof value.testId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value.testId)
  ) {
    receipt.remoteTestId = value.testId;
  }
  if (typeof value.resultUrl === 'string') {
    try {
      const url = new URL(value.resultUrl, row.destination_url);
      if (
        url.origin === new URL(row.destination_url).origin &&
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      ) {
        receipt.remoteResultUrl = url.href;
      }
    } catch {
      /* A receipt link is optional. */
    }
  }
  return receipt;
}

function retryHint(response: Response): number {
  const value = response.headers.get('Retry-After');
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.min(300_000, Math.max(0, delay)) : 0;
}

async function deliver(
  row: ForwardingDeliveryRow,
  bindings: typeof env,
): Promise<ForwardingReceipt> {
  const settings = snapshot(row);
  validateForwardingDestination(bindings, row.destination_url);
  const archive = await bindings.RESULTS_BUCKET.get(row.archive_key);
  if (!archive || archive.size !== row.archive_size) {
    throw new DeliveryFailure(
      'The retained original ZIP is missing or its size changed',
    );
  }
  const multipart = multipartBody(archive.body, row);
  const headers = new Headers({
    'Content-Type': multipart.contentType,
    'Content-Length': String(multipart.size),
    'Idempotency-Key': row.delivery_id,
    'X-Telescope-Forward-Id': row.delivery_id,
    'X-Telescope-Archive-SHA256': row.archive_sha256,
  });
  const chain: string[] = JSON.parse(row.instance_chain);
  headers.set('X-Telescope-Forward-Chain', chain.join(','));
  const bearer = getBindingString(bindings, 'UPLOAD_FORWARD_BEARER_TOKEN');
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  const peerSecret = getBindingString(bindings, 'UPLOAD_FORWARD_PEER_SECRET');
  if (peerSecret)
    headers.set(
      'X-Telescope-Forward-Signature',
      await hmac(
        peerSecret,
        `${row.delivery_id}\n${row.archive_sha256}\n${chain.join(',')}`,
      ),
    );
  let response: Response;
  try {
    response = await fetch(row.destination_url, {
      method: 'POST',
      body: multipart.body,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch {
    throw new DeliveryFailure(
      'Destination transport failed or timed out; acceptance is unknown',
      true,
    );
  }
  if (
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    if (response.body) await response.body.cancel();
    throw new DeliveryFailure(
      `Destination returned HTTP ${response.status}`,
      true,
      response.status,
      retryHint(response),
    );
  }
  if (
    settings.mode === 'telescope' &&
    (response.ok || response.status === 409)
  ) {
    return receiptFrom(response, row, await boundedResponse(response));
  }
  if (response.body) await response.body.cancel();
  if (!response.ok) {
    throw new DeliveryFailure(
      response.status >= 300 && response.status < 400
        ? 'Destination redirected; redirects are not followed'
        : `Destination returned HTTP ${response.status}`,
      false,
      response.status,
    );
  }
  return {
    status: response.status,
    accepted: true,
    durableStorageConfirmed: false,
  };
}

/** Reconcile and attempt a bounded batch; call from durable scheduled processing. */
export async function processForwarding(
  context?: { request: Request },
  bindings: typeof env = env,
  maxDeliveries = 1,
): Promise<ForwardingProcessResult> {
  const result = { claimed: 0, accepted: 0, retried: 0, failed: 0 };
  let configuration: ForwardingConfiguration | null = null;
  try {
    configuration = await getForwardingConfiguration(
      bindings,
      context ? new URL(context.request.url).origin : undefined,
    );
  } catch {
    // Misconfiguration must stop sends, while retaining expiry/cleanup recovery.
  }
  await reconcile(bindings, !!configuration, configuration?.version ?? null);
  await cleanupForwarding(bindings);
  if (!configuration) return result;
  for (
    let index = 0;
    index < Math.min(10, Math.max(1, maxDeliveries));
    index++
  ) {
    const now = Date.now();
    const candidate = await bindings.TELESCOPE_DB.prepare(
      `SELECT f.* FROM ${TABLE} f JOIN tests t ON t.test_id = f.test_id
       WHERE f.state IN ('pending','retrying') AND f.next_attempt_at <= ?
         AND f.source_expires_at > ? AND f.archive_deleted_at IS NULL
         AND f.config_version = ? AND t.publication_state = 'committed'
       ORDER BY f.next_attempt_at LIMIT 1`,
    )
      .bind(now, now, configuration.version)
      .first<ForwardingDeliveryRow>();
    if (!candidate) break;
    const settings = snapshot(candidate);
    if (
      candidate.attempt_count - candidate.retry_budget_start >=
      settings.maxAttempts
    ) {
      await bindings.TELESCOPE_DB.prepare(
        `UPDATE ${TABLE} SET state = 'failed', terminal_at = ?, updated_at = ?,
          last_error = 'Automatic attempt budget exhausted; an administrator may retry'
         WHERE delivery_id = ? AND state IN ('pending','retrying')`,
      )
        .bind(now, now, candidate.delivery_id)
        .run();
      result.failed++;
      continue;
    }
    const lease = crypto.randomUUID();
    const claimed = await bindings.TELESCOPE_DB.prepare(
      `UPDATE ${TABLE} SET state = 'sending', lease_token = ?, lease_expires_at = ?,
         attempt_count = attempt_count + 1, updated_at = ?
       WHERE delivery_id = ? AND state IN ('pending','retrying') AND next_attempt_at <= ?
         AND source_expires_at > ? AND archive_deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM tests WHERE tests.test_id = ${TABLE}.test_id
           AND publication_state = 'committed'
           AND (? = 0 OR content_rating = 'safe'))`,
    )
      .bind(
        lease,
        now + settings.timeoutMs + 60_000,
        now,
        candidate.delivery_id,
        now,
        now,
        settings.requireReview ? 1 : 0,
      )
      .run();
    if (!claimed.meta.changes) continue;
    result.claimed++;
    const row = {
      ...candidate,
      lease_token: lease,
      attempt_count: candidate.attempt_count + 1,
    };
    await bindings.TELESCOPE_DB.prepare(
      `INSERT INTO upload_forward_attempts
       (attempt_id, delivery_id, sequence, started_at, outcome) VALUES (?, ?, ?, ?, 'sending')`,
    )
      .bind(lease, row.delivery_id, row.attempt_count, now)
      .run();
    try {
      const receipt = await deliver(row, bindings);
      const committed = await bindings.TELESCOPE_DB.prepare(
        `UPDATE ${TABLE} SET state = 'accepted', receipt_json = ?, last_status = ?,
          last_error = CASE WHEN cancel_requested = 1 THEN 'Cancellation arrived after the destination accepted the archive' ELSE NULL END,
          terminal_at = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL
         WHERE delivery_id = ? AND state = 'sending' AND lease_token = ?`,
      )
        .bind(
          JSON.stringify(receipt),
          receipt.status,
          Date.now(),
          Date.now(),
          row.delivery_id,
          lease,
        )
        .run();
      await bindings.TELESCOPE_DB.prepare(
        `UPDATE upload_forward_attempts SET outcome = ?, ended_at = ?, status = ?
         WHERE attempt_id = ?`,
      )
        .bind(
          committed.meta.changes ? 'accepted' : 'late_accepted',
          Date.now(),
          receipt.status,
          lease,
        )
        .run();
      if (committed.meta.changes) result.accepted++;
    } catch (error) {
      const failure =
        error instanceof DeliveryFailure
          ? error
          : new DeliveryFailure(
              'Forwarding configuration or retained data is invalid',
            );
      const fresh = await bindings.TELESCOPE_DB.prepare(
        `SELECT cancel_requested FROM ${TABLE} WHERE delivery_id = ?`,
      )
        .bind(row.delivery_id)
        .first<{ cancel_requested: number }>();
      const jitter = crypto.getRandomValues(new Uint32Array(1))[0] % 1000;
      const delay = Math.max(
        failure.retryAfterMs,
        Math.min(
          300_000,
          1000 * 2 ** Math.min(10, row.attempt_count - row.retry_budget_start),
        ) + jitter,
      );
      const next = Date.now() + delay;
      const retry =
        failure.retryable &&
        row.attempt_count - row.retry_budget_start < settings.maxAttempts &&
        next < row.source_expires_at &&
        fresh?.cancel_requested !== 1;
      const state =
        fresh?.cancel_requested === 1
          ? 'cancelled'
          : retry
            ? 'retrying'
            : 'failed';
      await bindings.TELESCOPE_DB.prepare(
        `UPDATE ${TABLE} SET state = ?, last_status = ?, last_error = ?, next_attempt_at = ?,
          terminal_at = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL
         WHERE delivery_id = ? AND state = 'sending' AND lease_token = ?`,
      )
        .bind(
          state,
          failure.status,
          failure.message,
          next,
          retry ? null : Date.now(),
          Date.now(),
          row.delivery_id,
          lease,
        )
        .run();
      await bindings.TELESCOPE_DB.prepare(
        `UPDATE upload_forward_attempts SET outcome = ?, ended_at = ?, status = ?, error = ?
         WHERE attempt_id = ? AND ended_at IS NULL`,
      )
        .bind(state, Date.now(), failure.status, failure.message, lease)
        .run();
      if (retry) result.retried++;
      else result.failed++;
    }
  }
  await cleanupForwarding(bindings);
  return result;
}

/** Perform an authorized operator action while preserving immutable destination identity. */
export async function controlForwarding(
  deliveryId: string,
  action: 'retry' | 'pause' | 'resume' | 'cancel',
  bindings: typeof env = env,
): Promise<ForwardingDelivery> {
  const row = await bindings.TELESCOPE_DB.prepare(
    `SELECT * FROM ${TABLE} WHERE delivery_id = ?`,
  )
    .bind(deliveryId)
    .first<ForwardingDeliveryRow>();
  if (!row) throw new Error('Forwarding delivery not found');
  const now = Date.now();
  if (action === 'cancel' && row.state === 'sending') {
    await bindings.TELESCOPE_DB.prepare(
      `UPDATE ${TABLE} SET cancel_requested = 1, updated_at = ?
       WHERE delivery_id = ? AND state = 'sending' AND lease_token = ?`,
    )
      .bind(now, deliveryId, row.lease_token)
      .run();
  } else if (action === 'pause' || action === 'cancel') {
    if (['sending', 'accepted', 'expired', 'blocked'].includes(row.state)) {
      throw new Error('This delivery cannot be changed by that action');
    }
    await bindings.TELESCOPE_DB.prepare(
      `UPDATE ${TABLE} SET state = ?, updated_at = ?, terminal_at = ?, lease_token = NULL,
        lease_expires_at = NULL, last_error = ? WHERE delivery_id = ? AND state = ?`,
    )
      .bind(
        action === 'pause' ? 'paused' : 'cancelled',
        now,
        action === 'cancel' ? now : null,
        action === 'pause'
          ? 'Paused by an administrator'
          : 'Cancelled by an administrator',
        deliveryId,
        row.state,
      )
      .run();
  } else {
    if (['sending', 'accepted', 'blocked', 'expired'].includes(row.state)) {
      throw new Error('This delivery cannot be retried or resumed');
    }
    const config = await getForwardingConfiguration(bindings);
    if (!config || config.version !== row.config_version) {
      throw new Error(
        'Restore and enable this delivery’s destination configuration before retrying',
      );
    }
    if (
      row.source_expires_at <= now ||
      row.archive_deleted_at ||
      !(await bindings.RESULTS_BUCKET.head(row.archive_key))
    ) {
      throw new Error(
        'Original ZIP is no longer retained; a different ZIP will not be reconstructed',
      );
    }
    const test = await bindings.TELESCOPE_DB.prepare(
      'SELECT content_rating FROM tests WHERE test_id = ? AND publication_state = ?',
    )
      .bind(row.test_id, 'committed')
      .first<{ content_rating: string }>();
    if (!test) throw new Error('Local result is not committed or was removed');
    const requiresReview = snapshot(row).requireReview;
    if (requiresReview && test.content_rating === 'unsafe')
      throw new Error('Content review blocked forwarding');
    const state =
      requiresReview && test.content_rating !== 'safe'
        ? 'waiting_review'
        : 'pending';
    await bindings.TELESCOPE_DB.prepare(
      `UPDATE ${TABLE} SET state = ?, updated_at = ?, next_attempt_at = ?, terminal_at = NULL,
       cancel_requested = 0, last_error = NULL,
       retry_budget_start = CASE WHEN ? = 'retry' THEN attempt_count ELSE retry_budget_start END
       WHERE delivery_id = ? AND state = ?`,
    )
      .bind(state, now, now, action, deliveryId, row.state)
      .run();
  }
  const updated = await bindings.TELESCOPE_DB.prepare(
    `SELECT * FROM ${TABLE} WHERE delivery_id = ?`,
  )
    .bind(deliveryId)
    .first<ForwardingDeliveryRow>();
  if (!updated) throw new Error('Forwarding delivery no longer exists');
  return describeForwarding(updated);
}

/** Expose operational counters without revealing ZIP contents or destination secrets. */
export async function forwardingSummary(bindings: typeof env = env) {
  const rows = await bindings.TELESCOPE_DB.prepare(
    `SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_at,
       SUM(CASE WHEN archive_deleted_at IS NULL THEN archive_size ELSE 0 END) AS retained_bytes
     FROM ${TABLE} GROUP BY state`,
  ).all<{
    state: string;
    count: number;
    oldest_at: number;
    retained_bytes: number;
  }>();
  return rows.results.map(row => ({
    state: row.state,
    count: row.count,
    oldestAt: iso(row.oldest_at),
    retainedBytes: row.retained_bytes,
  }));
}

export { forwardingEnabled, getForwardingConfiguration };
