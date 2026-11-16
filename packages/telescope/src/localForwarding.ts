import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { IncomingHttpHeaders } from 'node:http';
import type { LocalStore } from './localStore.js';
import type {
  ForwardingDelivery,
  ForwardingReceipt,
  ForwardingState,
  ForwardMetadata,
} from './types.js';

interface Settings {
  url: string;
  label: string;
  mode: 'http' | 'telescope';
  instance: string;
  version: string;
  timeout: number;
  attempts: number;
  maxAge: number;
  maxArchive: number;
  maxSpool: number;
  terminalRetention: number;
  acceptedRetention: number;
  review: boolean;
}

interface Attempt {
  attemptId: string;
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  outcome: string;
  status: number | null;
  error: string | null;
}

interface DeliveryRecord {
  schemaVersion: 1;
  id: string;
  testId: string;
  sha256: string;
  bytes: number;
  filename: string;
  metadata: ForwardMetadata;
  settings: Settings;
  state: ForwardingState;
  createdAt: number;
  updatedAt: number;
  nextAt: number;
  expiresAt: number;
  terminalAt?: number;
  sourceDeletedAt?: number;
  lease?: string;
  leaseExpiresAt?: number;
  retryBudgetStart: number;
  attemptCount: number;
  cancelled?: boolean;
  error: string | null;
  lastStatus: number | null;
  receipt: ForwardingReceipt | null;
  attempts: Attempt[];
}

class ForwardFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status: number | null = null,
    readonly retryAfter = 0,
  ) {
    super(message);
    this.name = 'ForwardFailure';
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL: ForwardingState[] = [
  'accepted',
  'blocked',
  'expired',
  'failed',
  'cancelled',
];

function writeJson(filename: string, value: unknown): void {
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
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(filename), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function numeric(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} is outside its supported range`);
  return value;
}

function constantTime(a: string, b: string): boolean {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a).digest(),
    crypto.createHash('sha256').update(b).digest(),
  );
}

function publicRecord(row: DeliveryRecord): ForwardingDelivery {
  return {
    deliveryId: row.id,
    testId: row.testId,
    destinationLabel: row.settings.label,
    state: row.state,
    attemptCount: row.attemptCount,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    nextAttemptAt: ['pending', 'retrying'].includes(row.state)
      ? new Date(row.nextAt).toISOString()
      : null,
    sourceExpiresAt: new Date(row.expiresAt).toISOString(),
    lastStatus: row.lastStatus,
    error: row.error,
    receipt: row.receipt,
    retryAvailable:
      !row.sourceDeletedAt &&
      row.expiresAt > Date.now() &&
      !['accepted', 'sending', 'blocked', 'expired'].includes(row.state),
    cancellationRequested: !!row.cancelled,
  };
}

function recordObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

/**
 * Filesystem-backed original-ZIP outbox for the installed local workspace.
 * The LocalStore workspace lease must remain held for this object's lifetime.
 */
export class LocalForwarder {
  private readonly recordsRoot: string;
  private readonly sourcesRoot: string;
  private timer?: ReturnType<typeof setInterval>;
  private processing?: Promise<unknown>;
  private active?: { id: string; abort: AbortController };
  private stopped = false;

  constructor(
    private readonly store: LocalStore,
    private readonly ownOrigin?: string,
  ) {
    const root = path.join(store.metadataRoot, 'forwarding');
    this.recordsRoot = path.join(root, 'deliveries');
    this.sourcesRoot = path.join(root, 'sources');
    for (const directory of [root, this.recordsRoot, this.sourcesRoot]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const relative = path.relative(
        store.metadataRoot,
        fs.realpathSync(directory),
      );
      if (
        fs.lstatSync(directory).isSymbolicLink() ||
        relative.startsWith('..') ||
        path.isAbsolute(relative)
      ) {
        throw new Error(
          'Forwarding storage must remain inside the private workspace',
        );
      }
    }
  }

  private configuration(): Settings | null {
    const raw = process.env.UPLOAD_FORWARD_URL;
    if (!raw || process.env.UPLOAD_FORWARD_ENABLED === 'false') return null;
    const url = new URL(raw);
    if (url.username || url.password || url.hash)
      throw new Error(
        'Forwarding URLs cannot contain credentials or fragments',
      );
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        process.env.UPLOAD_FORWARD_ALLOW_HTTP === 'true'
      )
    ) {
      throw new Error(
        'Forwarding requires HTTPS unless the administrator explicitly allows local HTTP',
      );
    }
    const aliases = (process.env.TELESCOPE_INSTANCE_ORIGINS ?? '')
      .split(',')
      .map(value => value.trim());
    if (this.ownOrigin) aliases.push(this.ownOrigin);
    if (
      aliases.includes(url.origin) &&
      /^\/api\/(?:upload|local\/import)\/?$/.test(url.pathname)
    ) {
      throw new Error('The forwarding endpoint belongs to this instance');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const privateName =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.internal') ||
      !hostname.includes('.') ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname === '::1' ||
      /^(?:f[cd][a-f0-9]{2}|fe80):/.test(hostname);
    if (privateName && process.env.UPLOAD_FORWARD_ALLOW_PRIVATE !== 'true')
      throw new Error(
        'Private forwarding requires UPLOAD_FORWARD_ALLOW_PRIVATE=true',
      );
    const instance = process.env.TELESCOPE_INSTANCE_ID;
    if (!instance || !/^[a-zA-Z0-9_-]{8,128}$/.test(instance))
      throw new Error(
        'Configure a stable TELESCOPE_INSTANCE_ID before forwarding',
      );
    const mode = process.env.UPLOAD_FORWARD_MODE ?? 'http';
    if (mode !== 'http' && mode !== 'telescope')
      throw new Error('UPLOAD_FORWARD_MODE must be http or telescope');
    const review = process.env.ENABLE_AI_RATING === 'true';
    const version = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          destinationUrl: url.href,
          mode,
          review,
          revision: process.env.UPLOAD_FORWARD_CONFIG_VERSION ?? '1',
        }),
      )
      .digest('hex');
    return {
      url: url.href,
      label: (
        process.env.UPLOAD_FORWARD_LABEL ?? 'Configured destination'
      ).slice(0, 160),
      mode,
      instance,
      version,
      review,
      timeout: numeric('UPLOAD_FORWARD_TIMEOUT_MS', 15_000, 1000, 120_000),
      attempts: numeric('UPLOAD_FORWARD_MAX_ATTEMPTS', 6, 1, 30),
      maxAge: numeric(
        'UPLOAD_FORWARD_MAX_AGE_MS',
        86_400_000,
        60_000,
        30 * 86_400_000,
      ),
      maxArchive: numeric(
        'UPLOAD_FORWARD_MAX_ARCHIVE_BYTES',
        32 * 1024 * 1024,
        1,
        256 * 1024 * 1024,
      ),
      maxSpool: numeric(
        'UPLOAD_FORWARD_MAX_SPOOL_BYTES',
        1024 ** 3,
        1,
        1024 ** 4,
      ),
      terminalRetention: numeric(
        'UPLOAD_FORWARD_FAILED_RETENTION_MS',
        86_400_000,
        0,
        30 * 86_400_000,
      ),
      acceptedRetention: numeric(
        'UPLOAD_FORWARD_ACCEPTED_RETENTION_MS',
        0,
        0,
        30 * 86_400_000,
      ),
    };
  }

  private filename(id: string): string {
    if (!UUID.test(id)) throw new Error('Invalid forwarding delivery ID');
    return path.join(this.recordsRoot, `${id}.json`);
  }

  private source(id: string): string {
    if (!UUID.test(id)) throw new Error('Invalid forwarding delivery ID');
    return path.join(this.sourcesRoot, `${id}.zip`);
  }

  private rows(): DeliveryRecord[] {
    return fs.readdirSync(this.recordsRoot).flatMap(name => {
      if (!UUID.test(name.replace(/\.json$/, '')) || !name.endsWith('.json'))
        return [];
      try {
        const filename = path.join(this.recordsRoot, name);
        if (
          fs.lstatSync(filename).isSymbolicLink() ||
          fs.statSync(filename).size > 1024 * 1024
        )
          return [];
        const row = JSON.parse(
          fs.readFileSync(filename, 'utf8'),
        ) as DeliveryRecord;
        return row.schemaVersion === 1 && row.id === name.slice(0, -5)
          ? [row]
          : [];
      } catch {
        return [];
      }
    });
  }

  private write(row: DeliveryRecord): void {
    row.updatedAt = Date.now();
    writeJson(this.filename(row.id), row);
  }

  private read(id: string): DeliveryRecord {
    const filename = this.filename(id);
    if (fs.lstatSync(filename).isSymbolicLink())
      throw new Error('Invalid delivery record');
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as DeliveryRecord;
  }

  private review(row: DeliveryRecord): string {
    try {
      const filename = path.join(
        this.store.metadataRoot,
        'runs',
        `${row.testId}.json`,
      );
      if (fs.lstatSync(filename).isSymbolicLink()) return 'unknown';
      const value = recordObject(JSON.parse(fs.readFileSync(filename, 'utf8')));
      const rating = value.contentRating ?? value.content_rating;
      return typeof rating === 'string' ? rating : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Inform upload UI of the destination label without exposing URLs or secrets. */
  status(): {
    enabled: boolean;
    destinationLabel: string | null;
    originalArchive: true;
  } {
    const enabled =
      !!process.env.UPLOAD_FORWARD_URL &&
      process.env.UPLOAD_FORWARD_ENABLED !== 'false';
    return {
      enabled,
      destinationLabel: enabled
        ? (process.env.UPLOAD_FORWARD_LABEL ?? 'Configured destination')
        : null,
      originalArchive: true,
    };
  }

  private trusted(
    headers: IncomingHttpHeaders | undefined,
    sha256: string,
  ): boolean {
    const secret = process.env.UPLOAD_FORWARD_PEER_SECRET;
    if (!secret || !headers) return false;
    const id = headers['x-telescope-forward-id'];
    const chain = headers['x-telescope-forward-chain'];
    const signature = headers['x-telescope-forward-signature'];
    if (
      typeof id !== 'string' ||
      typeof chain !== 'string' ||
      typeof signature !== 'string' ||
      !UUID.test(id) ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      chain.split(',').length > 8 ||
      chain.split(',').some(item => !/^[a-zA-Z0-9_-]{8,128}$/.test(item))
    )
      return false;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${id}\n${sha256}\n${chain}`)
      .digest('hex');
    return constantTime(expected, signature);
  }

  /**
   * Retains original bytes and commits an intent synchronously before import publication.
   * Pass this as LocalStore.importResult's beforePublish callback; duplicate imports skip it.
   */
  prepare(
    bytes: Buffer,
    receipt: { testId: string; duplicate: false },
    metadata: Partial<ForwardMetadata> = {},
    requestHeaders?: IncomingHttpHeaders,
  ): void {
    const settings = this.configuration();
    if (!settings) return;
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (this.trusted(requestHeaders, sha256)) return;
    if (bytes.length > settings.maxArchive)
      throw new Error(
        'Original ZIP exceeds the configured forwarding size limit',
      );
    const rows = this.rows();
    if (
      rows.some(
        row =>
          row.testId === receipt.testId &&
          row.settings.version === settings.version,
      )
    )
      return;
    const retained = rows.reduce(
      (sum, row) => sum + (row.sourceDeletedAt ? 0 : row.bytes),
      0,
    );
    if (retained + bytes.length > settings.maxSpool)
      throw new Error('Forwarding spool is full; the import was not accepted');
    const id = crypto.randomUUID();
    const source = this.source(id);
    const descriptor = fs.openSync(source, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const now = Date.now();
    const row: DeliveryRecord = {
      schemaVersion: 1,
      id,
      testId: receipt.testId,
      sha256,
      bytes: bytes.length,
      filename:
        (metadata.filename ?? `${receipt.testId}.zip`)
          .split(/[\\/]/)
          .pop()!
          .replace(/[\x00-\x1f\x7f"]/g, '_')
          .slice(0, 180) || 'result.zip',
      metadata: {
        source: /^[a-z]{1,32}$/.test(metadata.source ?? '')
          ? metadata.source!
          : 'upload',
        ...(metadata.name ? { name: metadata.name.slice(0, 256) } : {}),
        ...(metadata.description
          ? { description: metadata.description.slice(0, 10_000) }
          : {}),
      },
      settings,
      state: 'awaiting_local_commit',
      createdAt: now,
      updatedAt: now,
      nextAt: now,
      expiresAt: now + settings.maxAge,
      retryBudgetStart: 0,
      attemptCount: 0,
      error: null,
      lastStatus: null,
      receipt: null,
      attempts: [],
    };
    try {
      this.write(row);
    } catch (error) {
      fs.rmSync(source, { force: true });
      throw error;
    }
  }

  /** Starts a durable filesystem-outbox reconciler for the local server lifetime. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.process().catch(() =>
        console.error('Local forwarding reconciliation failed'),
      );
    }, 5000);
    this.timer.unref();
    void this.process().catch(() =>
      console.error('Local forwarding reconciliation failed'),
    );
  }

  /** Stops sending, records an interrupted transfer for retry, and leaves saved results intact. */
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.active?.abort.abort();
    await this.processing;
  }

  /** Lists only browser-safe operational state. */
  list(testId?: string): ForwardingDelivery[] {
    return this.rows()
      .filter(row => !testId || row.testId === testId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map(publicRecord);
  }

  private cleanup(row: DeliveryRecord, now: number): void {
    if (!TERMINAL.includes(row.state) || !row.terminalAt || row.sourceDeletedAt)
      return;
    const retain =
      row.state === 'accepted'
        ? row.settings.acceptedRetention
        : row.settings.terminalRetention;
    if (row.terminalAt + retain > now) return;
    const filename = this.source(row.id);
    if (fs.existsSync(filename)) {
      if (fs.lstatSync(filename).isSymbolicLink())
        throw new Error('Invalid forwarding source');
      fs.rmSync(filename);
    }
    row.sourceDeletedAt = now;
    this.write(row);
  }

  private reconcile(settings: Settings | null): DeliveryRecord[] {
    const now = Date.now();
    const rows = this.rows();
    for (const row of rows) {
      if (TERMINAL.includes(row.state)) {
        this.cleanup(row, now);
        continue;
      }
      if (row.state === 'sending' && (row.leaseExpiresAt ?? 0) <= now) {
        const attempt = row.attempts.find(item => item.attemptId === row.lease);
        if (attempt && !attempt.endedAt) {
          attempt.outcome = 'unknown';
          attempt.endedAt = new Date(now).toISOString();
          attempt.error =
            'Transfer owner stopped; destination acceptance is unknown';
        }
        row.state = row.cancelled ? 'cancelled' : 'retrying';
        if (row.cancelled) row.terminalAt = now;
        row.nextAt = now;
        delete row.lease;
        delete row.leaseExpiresAt;
      }
      if (row.state === 'sending') continue;
      if (TERMINAL.includes(row.state)) {
        this.write(row);
        this.cleanup(row, now);
        continue;
      }
      if (row.expiresAt <= now) {
        row.state = 'expired';
        row.terminalAt = now;
        row.error = 'Original ZIP retention deadline expired';
      } else if (row.state === 'awaiting_local_commit') {
        if (this.store.resultSummary(row.testId))
          row.state = row.settings.review ? 'waiting_review' : 'pending';
        else if (row.createdAt + 300_000 <= now) {
          row.state = 'failed';
          row.terminalAt = now;
          row.error = 'Local import never reached durable publication';
        }
      } else if (!this.store.resultSummary(row.testId)) {
        row.state = 'cancelled';
        row.terminalAt = now;
        row.error = 'Local result was removed before delivery';
      }
      if (
        !TERMINAL.includes(row.state) &&
        row.state !== 'awaiting_local_commit'
      ) {
        if (!settings || row.settings.version !== settings.version) {
          row.state = 'paused';
          row.error =
            'Forwarding is disabled or the destination configuration changed; explicit resume is required';
        } else if (row.settings.review && this.review(row) === 'unsafe') {
          row.state = 'blocked';
          row.terminalAt = now;
          row.error = 'Content review blocked forwarding';
        } else if (
          row.settings.review &&
          this.review(row) !== 'safe' &&
          row.state !== 'paused'
        )
          row.state = 'waiting_review';
        else if (row.state === 'waiting_review') row.state = 'pending';
      }
      this.write(row);
      this.cleanup(row, now);
    }
    const knownSources = new Set(rows.map(row => `${row.id}.zip`));
    for (const filename of fs.readdirSync(this.sourcesRoot)) {
      if (
        knownSources.has(filename) ||
        !UUID.test(filename.replace(/\.zip$/, '')) ||
        !filename.endsWith('.zip')
      )
        continue;
      const source = path.join(this.sourcesRoot, filename);
      const stat = fs.lstatSync(source);
      if (
        !stat.isSymbolicLink() &&
        stat.isFile() &&
        stat.mtimeMs + 300_000 < now
      )
        fs.rmSync(source);
    }
    return rows;
  }

  /** Reconciles storage and processes one due delivery, independently from the import request. */
  async process(): Promise<{
    claimed: number;
    accepted: number;
    retried: number;
    failed: number;
  }> {
    if (this.processing || this.stopped)
      return { claimed: 0, accepted: 0, retried: 0, failed: 0 };
    const work = this.processOne();
    this.processing = work;
    try {
      return await work;
    } finally {
      this.processing = undefined;
    }
  }

  private async processOne(): Promise<{
    claimed: number;
    accepted: number;
    retried: number;
    failed: number;
  }> {
    let settings: Settings | null = null;
    try {
      settings = this.configuration();
    } catch {
      /* Invalid configuration pauses sends but not cleanup. */
    }
    const result = { claimed: 0, accepted: 0, retried: 0, failed: 0 };
    const rows = this.reconcile(settings);
    if (!settings || this.stopped) return result;
    const row = rows
      .filter(
        item =>
          ['pending', 'retrying'].includes(item.state) &&
          item.nextAt <= Date.now(),
      )
      .sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!row) return result;
    if (row.attemptCount - row.retryBudgetStart >= row.settings.attempts) {
      row.state = 'failed';
      row.terminalAt = Date.now();
      row.error = 'Automatic retry budget exhausted';
      this.write(row);
      result.failed = 1;
      return result;
    }
    const lease = crypto.randomUUID();
    const now = Date.now();
    row.lease = lease;
    row.leaseExpiresAt = now + row.settings.timeout + 60_000;
    row.state = 'sending';
    row.attemptCount++;
    row.attempts.push({
      attemptId: lease,
      sequence: row.attemptCount,
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      outcome: 'sending',
      status: null,
      error: null,
    });
    if (row.attempts.length > 100)
      row.attempts.splice(0, row.attempts.length - 100);
    this.write(row);
    result.claimed = 1;
    const abort = new AbortController();
    this.active = { id: row.id, abort };
    const timeout = setTimeout(() => abort.abort(), row.settings.timeout);
    timeout.unref();
    try {
      const receipt = await this.send(row, abort.signal);
      const current = this.read(row.id);
      if (current.lease !== lease || current.state !== 'sending') return result;
      current.receipt = receipt;
      current.lastStatus = receipt.status;
      current.state = 'accepted';
      current.terminalAt = Date.now();
      current.error = current.cancelled
        ? 'Cancellation arrived after destination acceptance'
        : null;
      const attempt = current.attempts.find(item => item.attemptId === lease)!;
      attempt.outcome = 'accepted';
      attempt.endedAt = new Date().toISOString();
      attempt.status = receipt.status;
      delete current.lease;
      delete current.leaseExpiresAt;
      this.write(current);
      this.cleanup(current, Date.now());
      result.accepted = 1;
    } catch (error) {
      const failure =
        error instanceof ForwardFailure
          ? error
          : new ForwardFailure(
              'Destination transport failed or timed out; acceptance is unknown',
              true,
            );
      const current = this.read(row.id);
      if (current.lease !== lease || current.state !== 'sending') return result;
      const delay = Math.max(
        failure.retryAfter,
        Math.min(
          300_000,
          1000 *
            2 ** Math.min(10, current.attemptCount - current.retryBudgetStart),
        ) + crypto.randomInt(1000),
      );
      const next = Date.now() + delay;
      const retry =
        failure.retryable &&
        current.attemptCount - current.retryBudgetStart <
          current.settings.attempts &&
        next < current.expiresAt &&
        !current.cancelled;
      current.state = current.cancelled
        ? 'cancelled'
        : retry
          ? 'retrying'
          : 'failed';
      current.error = failure.message;
      current.lastStatus = failure.status;
      current.nextAt = next;
      if (!retry) current.terminalAt = Date.now();
      const attempt = current.attempts.find(item => item.attemptId === lease)!;
      attempt.outcome = current.state;
      attempt.endedAt = new Date().toISOString();
      attempt.status = failure.status;
      attempt.error = failure.message;
      delete current.lease;
      delete current.leaseExpiresAt;
      this.write(current);
      this.cleanup(current, Date.now());
      if (retry) result.retried = 1;
      else result.failed = 1;
    } finally {
      clearTimeout(timeout);
      this.active = undefined;
    }
    return result;
  }

  private async send(
    row: DeliveryRecord,
    signal: AbortSignal,
  ): Promise<ForwardingReceipt> {
    const filename = this.source(row.id);
    if (
      !fs.existsSync(filename) ||
      fs.lstatSync(filename).isSymbolicLink() ||
      fs.statSync(filename).size !== row.bytes
    ) {
      throw new ForwardFailure(
        'The retained original ZIP is missing or changed',
      );
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename, { signal }))
      hash.update(chunk as Buffer);
    if (hash.digest('hex') !== row.sha256)
      throw new ForwardFailure('Retained ZIP integrity check failed');
    const boundary = `telescope-${crypto.randomUUID()}`;
    const fields: string[] = [];
    for (const field of ['source', 'name', 'description'] as const) {
      if (typeof row.metadata[field] === 'string')
        fields.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${row.metadata[field]}\r\n`,
        );
    }
    fields.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${row.filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    );
    const prefix = Buffer.from(fields.join(''));
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    async function* payload() {
      yield prefix;
      for await (const chunk of fs.createReadStream(filename, { signal }))
        yield chunk as Buffer;
      yield suffix;
    }
    const stream = Readable.from(payload());
    const headers = new Headers({
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(prefix.length + row.bytes + suffix.length),
      'Idempotency-Key': row.id,
      'X-Telescope-Forward-Id': row.id,
      'X-Telescope-Archive-SHA256': row.sha256,
      'X-Telescope-Forward-Chain': row.settings.instance,
    });
    if (process.env.UPLOAD_FORWARD_BEARER_TOKEN)
      headers.set(
        'Authorization',
        `Bearer ${process.env.UPLOAD_FORWARD_BEARER_TOKEN}`,
      );
    if (process.env.UPLOAD_FORWARD_PEER_SECRET)
      headers.set(
        'X-Telescope-Forward-Signature',
        crypto
          .createHmac('sha256', process.env.UPLOAD_FORWARD_PEER_SECRET)
          .update(`${row.id}\n${row.sha256}\n${row.settings.instance}`)
          .digest('hex'),
      );
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers,
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      signal,
      redirect: 'manual',
      duplex: 'half',
    };
    let response: Response;
    try {
      response = await fetch(row.settings.url, init);
    } catch {
      stream.destroy();
      throw new ForwardFailure(
        'Destination transport failed or timed out; acceptance is unknown',
        true,
      );
    }
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      await response.body?.cancel();
      const retryAfter = response.headers.get('Retry-After');
      const seconds = Number(retryAfter);
      const hint = retryAfter
        ? Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now()
        : 0;
      throw new ForwardFailure(
        `Destination returned HTTP ${response.status}`,
        true,
        response.status,
        Number.isFinite(hint) ? Math.max(0, Math.min(300_000, hint)) : 0,
      );
    }
    if (
      row.settings.mode === 'telescope' &&
      (response.ok || response.status === 409)
    ) {
      const text = await this.readReceipt(response);
      let value: Record<string, unknown>;
      try {
        value = recordObject(JSON.parse(text));
      } catch {
        throw new ForwardFailure(
          'Invalid Telescope receipt',
          false,
          response.status,
        );
      }
      const match =
        value.zipKey === row.sha256 ||
        value.sha256 === row.sha256 ||
        value.archiveSha256 === row.sha256 ||
        value.deliveryId === row.id;
      if (
        !match ||
        !(
          (response.ok && value.success === true) ||
          (response.status === 409 && value.duplicate === true)
        )
      ) {
        throw new ForwardFailure(
          'Receipt did not confirm this archive/delivery',
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
      )
        receipt.remoteTestId = value.testId;
      if (typeof value.resultUrl === 'string') {
        try {
          const link = new URL(value.resultUrl, row.settings.url);
          if (
            link.origin === new URL(row.settings.url).origin &&
            ['http:', 'https:'].includes(link.protocol) &&
            !link.username &&
            !link.password &&
            !link.search &&
            !link.hash
          )
            receipt.remoteResultUrl = link.href;
        } catch {
          /* Optional receipt URL. */
        }
      }
      return receipt;
    }
    await response.body?.cancel();
    if (!response.ok)
      throw new ForwardFailure(
        response.status >= 300 && response.status < 400
          ? 'Destination redirected; redirects are not followed'
          : `Destination returned HTTP ${response.status}`,
        false,
        response.status,
      );
    return {
      status: response.status,
      accepted: true,
      durableStorageConfirmed: false,
    };
  }

  private async readReceipt(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          throw new ForwardFailure('Destination receipt exceeds 8 KiB');
        }
        parts.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(parts).toString('utf8');
  }

  /** Resolves pending forwarding ownership before the local result is removed. */
  async cancelResult(testId: string): Promise<void> {
    for (const row of this.rows().filter(item => item.testId === testId)) {
      if (!TERMINAL.includes(row.state)) await this.control(row.id, 'cancel');
      const current = this.read(row.id);
      current.metadata = { source: current.metadata.source };
      current.filename = 'result.zip';
      this.write(current);
    }
  }

  /** Applies one authenticated local administrator action. */
  async control(
    id: string,
    action: 'retry' | 'pause' | 'resume' | 'cancel',
  ): Promise<ForwardingDelivery> {
    const row = this.read(id);
    if (row.state === 'sending') {
      if (action !== 'cancel')
        throw new Error(
          'Only cancellation can be requested for an active transfer',
        );
      row.cancelled = true;
      this.write(row);
      this.active?.id === id && this.active.abort.abort();
      return publicRecord(row);
    }
    if (['accepted', 'blocked', 'expired'].includes(row.state))
      throw new Error('This terminal delivery cannot be changed');
    if (action === 'pause' || action === 'cancel') {
      row.state = action === 'pause' ? 'paused' : 'cancelled';
      row.error =
        action === 'pause'
          ? 'Paused by an administrator'
          : 'Cancelled by an administrator';
      if (action === 'cancel') row.terminalAt = Date.now();
    } else {
      const settings = this.configuration();
      if (!settings || settings.version !== row.settings.version)
        throw new Error(
          'Restore and enable the original destination configuration first',
        );
      if (
        row.sourceDeletedAt ||
        row.expiresAt <= Date.now() ||
        !fs.existsSync(this.source(id))
      )
        throw new Error('Original ZIP is no longer retained');
      if (!this.store.resultSummary(row.testId))
        throw new Error('Local result is not committed');
      if (row.settings.review && this.review(row) === 'unsafe')
        throw new Error('Content review blocked forwarding');
      row.state =
        row.settings.review && this.review(row) !== 'safe'
          ? 'waiting_review'
          : 'pending';
      row.nextAt = Date.now();
      row.error = null;
      delete row.terminalAt;
      row.cancelled = false;
      if (action === 'retry') row.retryBudgetStart = row.attemptCount;
    }
    this.write(row);
    return publicRecord(row);
  }

  /** Handles only requests already authorized by the local server's session boundary. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean).pop() ?? 'status';
    const json = (value: unknown, status = 200): Response =>
      Response.json(value, {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    try {
      if (request.method === 'GET') {
        if (action === 'status') return json(this.status());
        if (action === 'list')
          return json({
            deliveries: this.list(url.searchParams.get('testId') ?? undefined),
          });
        if (action === 'history')
          return json({
            attempts: this.read(url.searchParams.get('deliveryId') ?? '')
              .attempts.slice(-100)
              .reverse(),
          });
        if (action === 'summary') {
          const states = new Map<
            string,
            {
              state: string;
              count: number;
              oldestAt: string;
              retainedBytes: number;
            }
          >();
          for (const row of this.rows()) {
            const current = states.get(row.state) ?? {
              state: row.state,
              count: 0,
              oldestAt: new Date(row.createdAt).toISOString(),
              retainedBytes: 0,
            };
            current.count++;
            current.oldestAt = new Date(
              Math.min(Date.parse(current.oldestAt), row.createdAt),
            ).toISOString();
            current.retainedBytes += row.sourceDeletedAt ? 0 : row.bytes;
            states.set(row.state, current);
          }
          return json({ states: [...states.values()] });
        }
      }
      if (request.method === 'POST' && action === 'process')
        return json(await this.process());
      if (
        request.method === 'POST' &&
        ['retry', 'pause', 'resume', 'cancel'].includes(action)
      ) {
        if (!request.body) throw new Error('Control request body is required');
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
              return json({ error: 'Control request is too large' }, 413);
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const value = recordObject(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        if (typeof value.deliveryId !== 'string')
          throw new Error('Delivery ID is required');
        return json({
          delivery: await this.control(
            value.deliveryId,
            action as 'retry' | 'pause' | 'resume' | 'cancel',
          ),
        });
      }
      return json({ error: 'Unknown local forwarding action' }, 404);
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }
  }
}
