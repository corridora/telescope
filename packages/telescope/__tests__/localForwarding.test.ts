import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalForwarder } from '../src/localForwarding.js';
import { LocalStore } from '../src/localStore.js';

interface ReceivedUpload {
  archive: Buffer;
  filename: string;
  fields: Record<string, string>;
  headers: http.IncomingHttpHeaders;
}

interface ReceiverReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const fixtures = fileURLToPath(
  new URL('../tests/contracts/legacy/', import.meta.url),
);

describe('Local ZIP forwarding', () => {
  let temporary: string;
  let root: string;
  let store: LocalStore;
  let forwarder: LocalForwarder;
  let receiver: http.Server;
  let receiverUrl: string;
  let received: ReceivedUpload[];
  let receiverErrors: string[];
  let reply: (upload: ReceivedUpload) => ReceiverReply;

  beforeEach(async () => {
    const settings = new Set([
      ...Object.keys(process.env).filter(key =>
        key.startsWith('UPLOAD_FORWARD_'),
      ),
      'TELESCOPE_INSTANCE_ID',
      'TELESCOPE_INSTANCE_ORIGINS',
      'ENABLE_AI_RATING',
    ]);
    for (const setting of settings) vi.stubEnv(setting, undefined);
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'telescope-forwarding-'));
    root = path.join(temporary, 'saved results');
    received = [];
    receiverErrors = [];
    reply = () => ({ status: 204 });
    receiver = http.createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const wrapped = new Request('http://receiver.invalid/upload', {
          method: 'POST',
          headers: { 'Content-Type': request.headers['content-type'] ?? '' },
          body: new Uint8Array(bytes).buffer,
        });
        const form = await wrapped.formData();
        const file = form.get('file');
        if (!(file instanceof File))
          throw new Error('Multipart file is missing');
        const upload: ReceivedUpload = {
          archive: Buffer.from(await file.arrayBuffer()),
          filename: file.name,
          fields: Object.fromEntries(
            [...form.entries()].filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
          ),
          headers: request.headers,
        };
        received.push(upload);
        const result = reply(upload);
        response.writeHead(result.status, {
          ...(result.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...result.headers,
        });
        response.end(
          result.body === undefined ? undefined : JSON.stringify(result.body),
        );
      })().catch(error => {
        receiverErrors.push((error as Error).message);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      receiver.once('error', reject);
      receiver.listen(0, '127.0.0.1', () => {
        receiver.removeListener('error', reject);
        resolve();
      });
    });
    const address = receiver.address();
    if (!address || typeof address === 'string')
      throw new Error('Receiver has no TCP address');
    receiverUrl = `http://127.0.0.1:${address.port}/upload`;
    vi.stubEnv('UPLOAD_FORWARD_ENABLED', 'true');
    vi.stubEnv('UPLOAD_FORWARD_URL', receiverUrl);
    vi.stubEnv('UPLOAD_FORWARD_ALLOW_HTTP', 'true');
    vi.stubEnv('UPLOAD_FORWARD_ALLOW_PRIVATE', 'true');
    vi.stubEnv('UPLOAD_FORWARD_LABEL', 'Integration receiver');
    vi.stubEnv('UPLOAD_FORWARD_MAX_AGE_MS', '60000');
    vi.stubEnv('TELESCOPE_INSTANCE_ID', 'test_instance_one');
    vi.stubEnv('ENABLE_AI_RATING', 'false');
    store = new LocalStore(root);
    forwarder = new LocalForwarder(store, 'http://local-ui.invalid');
  });

  afterEach(async () => {
    await forwarder?.close();
    store?.close();
    if (receiver?.listening) {
      receiver.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        receiver.close(error => (error ? reject(error) : resolve())),
      );
    }
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    expect(receiverErrors).toEqual([]);
  });

  function archive(): { bytes: Buffer; testId: string } {
    const testId = `2026_11_16_00_00_00_${crypto.randomUUID()}`;
    const zip = new AdmZip();
    zip.addLocalFolder(fixtures);
    zip.addFile(
      'identity.json',
      Buffer.from(JSON.stringify({ schemaVersion: 1, testId })),
    );
    zip.addFile('extra/original.bin', Buffer.from([0, 255, 17, 13, 10, 42]));
    zip.addZipComment(
      'Preserve the original archive container and its binary entries',
    );
    return { bytes: zip.toBuffer(), testId };
  }

  function importWithForwarding(bytes: Buffer) {
    return store.importResult(bytes, receipt =>
      forwarder.prepare(
        bytes,
        receipt,
        {
          source: 'upload',
          name: 'Original upload',
          description: 'Keep the metadata\nunchanged',
          filename: '../original.zip',
        },
        {
          authorization: 'Bearer incoming-user-secret',
          cookie: 'session=must-not-forward',
        },
      ),
    );
  }

  it('posts exact original ZIP bytes and metadata while retaining an independent local result', async () => {
    vi.stubEnv('UPLOAD_FORWARD_BEARER_TOKEN', 'receiver-only-secret');
    const { bytes, testId } = archive();
    expect(importWithForwarding(bytes)).toEqual({ testId, duplicate: false });

    expect(await forwarder.process()).toEqual({
      claimed: 1,
      accepted: 1,
      retried: 0,
      failed: 0,
    });
    expect(received).toHaveLength(1);
    expect(received[0].archive.equals(bytes)).toBe(true);
    expect(new AdmZip(received[0].archive).getZipComment()).toBe(
      'Preserve the original archive container and its binary entries',
    );
    expect(received[0].filename).toBe('original.zip');
    expect(received[0].fields).toEqual({
      source: 'upload',
      name: 'Original upload',
      description: 'Keep the metadata\nunchanged',
    });
    expect(received[0].headers.authorization).toBe(
      'Bearer receiver-only-secret',
    );
    expect(received[0].headers.cookie).toBeUndefined();
    expect(received[0].headers['x-telescope-archive-sha256']).toBe(
      crypto.createHash('sha256').update(bytes).digest('hex'),
    );
    expect(store.resultSummary(testId)?.status).toBe('legacy');
    expect(
      fs.readFileSync(store.artifact(testId, 'extra/original.bin')),
    ).toEqual(Buffer.from([0, 255, 17, 13, 10, 42]));
    expect(
      fs.readdirSync(path.join(store.metadataRoot, 'forwarding', 'sources')),
    ).toEqual([]);
    expect(forwarder.list(testId)[0]).toMatchObject({
      state: 'accepted',
      attemptCount: 1,
      retryAvailable: false,
    });
  });

  it('does not dispatch a prepared archive before its local result is published', async () => {
    const { bytes, testId } = archive();
    forwarder.prepare(
      bytes,
      { testId, duplicate: false },
      { source: 'upload' },
    );
    expect(await forwarder.process()).toEqual({
      claimed: 0,
      accepted: 0,
      retried: 0,
      failed: 0,
    });
    expect(received).toHaveLength(0);
    expect(forwarder.list(testId)[0].state).toBe('awaiting_local_commit');

    expect(store.importResult(bytes)).toEqual({ testId, duplicate: false });
    expect((await forwarder.process()).accepted).toBe(1);
    expect(received[0].archive.equals(bytes)).toBe(true);
  });

  it('recovers a retry after service restart with the same archive and delivery identity', async () => {
    reply = () =>
      received.length === 1
        ? { status: 503, headers: { 'Retry-After': '0' } }
        : { status: 204 };
    const { bytes, testId } = archive();
    importWithForwarding(bytes);
    expect((await forwarder.process()).retried).toBe(1);
    const before = forwarder.list(testId)[0];
    expect(before).toMatchObject({ state: 'retrying', attemptCount: 1 });
    expect(before.nextAttemptAt).not.toBeNull();
    await forwarder.close();
    store.close();

    store = new LocalStore(root);
    forwarder = new LocalForwarder(store, 'http://local-ui.invalid');
    expect(forwarder.list(testId)[0]).toMatchObject({
      deliveryId: before.deliveryId,
      state: 'retrying',
      attemptCount: 1,
    });
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse(before.nextAttemptAt!) + 1,
    );
    expect((await forwarder.process()).accepted).toBe(1);
    expect(received).toHaveLength(2);
    expect(received.map(upload => upload.headers['idempotency-key'])).toEqual([
      before.deliveryId,
      before.deliveryId,
    ]);
    expect(received.every(upload => upload.archive.equals(bytes))).toBe(true);
    expect(forwarder.list(testId)[0]).toMatchObject({
      state: 'accepted',
      attemptCount: 2,
    });
    const historyResponse = await forwarder.handle(
      new Request(
        `http://local-ui.invalid/api/local/forwarding/history?deliveryId=${before.deliveryId}`,
      ),
    );
    expect(await historyResponse.json()).toMatchObject({
      attempts: [
        { sequence: 2, outcome: 'accepted' },
        { sequence: 1, outcome: 'retrying' },
      ],
    });
    expect(store.resultSummary(testId)).not.toBeNull();
  });

  it('suppresses a verified forwarding loop but does not trust a forged suppression marker', async () => {
    vi.stubEnv(
      'UPLOAD_FORWARD_PEER_SECRET',
      'trusted-peers-share-a-long-secret',
    );
    const trusted = archive();
    const incomingId = crypto.randomUUID();
    const chain = 'upstream_instance';
    const checksum = crypto
      .createHash('sha256')
      .update(trusted.bytes)
      .digest('hex');
    const signature = crypto
      .createHmac('sha256', process.env.UPLOAD_FORWARD_PEER_SECRET!)
      .update(`${incomingId}\n${checksum}\n${chain}`)
      .digest('hex');
    store.importResult(trusted.bytes, receipt =>
      forwarder.prepare(
        trusted.bytes,
        receipt,
        {},
        {
          'x-telescope-forward-id': incomingId,
          'x-telescope-forward-chain': chain,
          'x-telescope-forward-signature': signature,
        },
      ),
    );
    expect((await forwarder.process()).claimed).toBe(0);
    expect(forwarder.list(trusted.testId)).toEqual([]);

    const forged = archive();
    store.importResult(forged.bytes, receipt =>
      forwarder.prepare(
        forged.bytes,
        receipt,
        {},
        {
          'x-telescope-forward-id': incomingId,
          'x-telescope-forward-chain': chain,
          'x-telescope-forward-signature': '0'.repeat(64),
        },
      ),
    );
    expect((await forwarder.process()).accepted).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].archive.equals(forged.bytes)).toBe(true);
    expect(store.resultSummary(trusted.testId)).not.toBeNull();
  });

  it.each([
    {
      mode: 'http',
      status: 202,
      matching: false,
      accepted: true,
      durable: false,
    },
    {
      mode: 'http',
      status: 409,
      matching: true,
      accepted: false,
      durable: false,
    },
    {
      mode: 'telescope',
      status: 200,
      matching: false,
      accepted: false,
      durable: false,
    },
    {
      mode: 'telescope',
      status: 409,
      matching: true,
      accepted: true,
      durable: true,
    },
    {
      mode: 'telescope',
      status: 200,
      matching: true,
      accepted: true,
      durable: true,
    },
  ])(
    'applies the $mode acknowledgment contract to HTTP $status (matching=$matching)',
    async scenario => {
      vi.stubEnv('UPLOAD_FORWARD_MODE', scenario.mode);
      reply = upload => ({
        status: scenario.status,
        body: {
          success: scenario.status !== 409,
          duplicate: scenario.status === 409,
          archiveSha256: scenario.matching
            ? upload.headers['x-telescope-archive-sha256']
            : 'f'.repeat(64),
          publicationState: 'committed',
          testId: 'remote_result',
        },
      });
      const { bytes, testId } = archive();
      importWithForwarding(bytes);
      const result = await forwarder.process();
      const delivery = forwarder.list(testId)[0];
      expect(result.accepted).toBe(Number(scenario.accepted));
      expect(delivery.state).toBe(scenario.accepted ? 'accepted' : 'failed');
      if (scenario.accepted)
        expect(delivery.receipt?.durableStorageConfirmed).toBe(
          scenario.durable,
        );
      else expect(delivery.receipt).toBeNull();
      expect(store.resultSummary(testId)).not.toBeNull();
    },
  );

  it('rejects a redirect without issuing a follow-up request', async () => {
    vi.stubEnv('UPLOAD_FORWARD_BEARER_TOKEN', 'scoped-receiver-token');
    reply = () => ({
      status: 302,
      headers: { Location: `${receiverUrl}/unexpected-target` },
    });
    const { bytes, testId } = archive();
    importWithForwarding(bytes);
    expect((await forwarder.process()).failed).toBe(1);
    expect(received).toHaveLength(1);
    expect(forwarder.list(testId)[0]).toMatchObject({
      state: 'failed',
      lastStatus: 302,
    });
  });

  it('refuses a modified retained ZIP before any outbound request', async () => {
    const { bytes, testId } = archive();
    importWithForwarding(bytes);
    const delivery = forwarder.list(testId)[0];
    const retained = path.join(
      store.metadataRoot,
      'forwarding',
      'sources',
      `${delivery.deliveryId}.zip`,
    );
    const modified = Buffer.from(bytes);
    modified[modified.length - 1] ^= 1;
    fs.writeFileSync(retained, modified);

    expect((await forwarder.process()).failed).toBe(1);
    expect(received).toHaveLength(0);
    expect(forwarder.list(testId)[0]).toMatchObject({
      state: 'failed',
      error: 'Retained ZIP integrity check failed',
    });
    expect(store.resultSummary(testId)).not.toBeNull();
  });

  it('holds unrated captures and expires delivery without deleting their saved diagnostics', async () => {
    vi.stubEnv('ENABLE_AI_RATING', 'true');
    const { bytes, testId } = archive();
    importWithForwarding(bytes);
    expect((await forwarder.process()).claimed).toBe(0);
    const held = forwarder.list(testId)[0];
    expect(held.state).toBe('waiting_review');
    expect(received).toHaveLength(0);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(held.sourceExpiresAt) + 1);
    expect((await forwarder.process()).claimed).toBe(0);
    expect(forwarder.list(testId)[0].state).toBe('expired');
    expect(received).toHaveLength(0);
    expect(store.resultSummary(testId)).not.toBeNull();
    expect(
      JSON.parse(
        fs.readFileSync(store.artifact(testId, 'metrics.json'), 'utf8'),
      ),
    ).toHaveProperty('navigationTiming');
  });
});
