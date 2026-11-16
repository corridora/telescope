import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { z } from 'zod';

import { DEFAULT_OPTIONS } from './defaultOptions.js';
import { recoverExecutionLease } from './executionLease.js';
import { createLocalAgentController } from './localAgentController.js';
import { LocalForwarder } from './localForwarding.js';
import { LocalStore } from './localStore.js';
import { parseLocalOptions, reusableLocalOptions } from './localOptions.js';
import { listTrustedScripts, resolveTrustedScript } from './scriptRegistry.js';
import type {
  LocalJob,
  LocalServerOptions,
  RunProgress,
  TestResult,
} from './types.js';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_QUEUE = 25;
const sessionCookie = 'telescope_local_session';
const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** Reads a bounded request without retaining an oversized upload in memory. */
function requestBytes(
  request: IncomingMessage,
  maximum: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on('data', (data: Buffer) => {
      size += data.length;
      if (size > maximum) {
        if (!rejected)
          reject(
            new Error(
              `Request exceeds the ${Math.floor(maximum / 1024 / 1024)} MB limit`,
            ),
          );
        rejected = true;
        chunks.length = 0;
        return;
      }
      if (!rejected) chunks.push(data);
    });
    request.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Upload interrupted')));
  });
}

/** Parses the intentionally small JSON control surface. */
async function requestJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new Error('Expected application/json');
  return JSON.parse(
    (await requestBytes(request, MAX_JSON_BYTES)).toString('utf8'),
  ) as unknown;
}

/** Adapts bounded local control/upload requests to the shared Web Request handlers. */
async function webRequest(
  request: IncomingMessage,
  url: URL,
  maximum = MAX_JSON_BYTES,
): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = request.method ?? 'GET';
  const body = ['GET', 'HEAD'].includes(method)
    ? undefined
    : new Uint8Array(await requestBytes(request, maximum));
  return new Request(url, { method, headers, body });
}

/** Streams shared controller responses through Node without buffering large response bodies. */
async function webResponse(
  value: Response,
  response: ServerResponse,
): Promise<void> {
  value.headers.forEach((entry, key) => response.setHeader(key, entry));
  const cookies = value.headers.getSetCookie();
  if (cookies.length) response.setHeader('Set-Cookie', cookies);
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.writeHead(value.status);
  if (!value.body) {
    response.end();
    return;
  }
  const reader = value.body.getReader();
  const disconnected = (): void => {
    void reader.cancel().catch(() => {});
  };
  response.once('close', disconnected);
  try {
    while (!response.destroyed) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!response.write(chunk.value))
        await new Promise<void>(resolve => {
          const ready = (): void => {
            response.off('drain', ready);
            response.off('close', ready);
            resolve();
          };
          response.once('drain', ready);
          response.once('close', ready);
        });
    }
    if (!response.destroyed) response.end();
  } finally {
    response.off('close', disconnected);
    reader.releaseLock();
  }
}

/** Sends private JSON without allowing shared-cache reuse of local captures. */
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

/** Compares a browser credential without an early character-by-character return. */
function sameToken(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const first = Buffer.from(expected);
  const second = Buffer.from(received);
  return (
    first.length === second.length && crypto.timingSafeEqual(first, second)
  );
}

/** Returns a browser-safe job snapshot without disclosing reusable credentials. */
function publicJob(job: LocalJob): LocalJob {
  return { ...job, options: reusableLocalOptions(job.options) };
}

/** Stops the worker's complete owned process group when graceful cancellation expires. */
function terminateWorker(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** Opens the host UI using an argument array rather than shell-interpolated input. */
function openLocalBrowser(url: string): void {
  if (process.env.CI || process.env.RUNNING_IN_DOCKER) return;
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32')
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], () => {});
  else execFile('xdg-open', [url], () => {});
}

/**
 * Starts the installed local workspace and supervises a serial browser job queue.
 * @param options - Bind address, port, persistent results directory, and browser-opening preference
 * @returns Once the local service is listening; the HTTP server then owns its lifetime
 */
export async function startLocalServer(
  options: LocalServerOptions = {},
): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4321;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Port must be between 1 and 65535');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const token =
    process.env.TELESCOPE_LOCAL_TOKEN ?? crypto.randomBytes(32).toString('hex');
  if (!/^[a-z0-9_-]{24,256}$/i.test(token))
    throw new Error(
      'TELESCOPE_LOCAL_TOKEN must contain 24–256 letters, digits, underscores, or hyphens',
    );
  const allowedHosts = new Set([
    '127.0.0.1',
    'localhost',
    '[::1]',
    '::1',
    ...(!['0.0.0.0', '::'].includes(host) ? [host.toLowerCase()] : []),
    ...(process.env.TELESCOPE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  ]);
  const store = new LocalStore(
    options.resultsDir ?? DEFAULT_OPTIONS.resultsDir,
  );
  const displayHost =
    host === '::1'
      ? '[::1]'
      : ['0.0.0.0', '::'].includes(host)
        ? '127.0.0.1'
        : host;
  const ownOrigin = `http://${displayHost}:${port}`;
  const localCredential = (headers: Headers): boolean => {
    const bearer = headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    const cookie = (headers.get('cookie') ?? '')
      .split(';')
      .map(value => value.trim())
      .find(value => value.startsWith(`${sessionCookie}=`))
      ?.slice(sessionCookie.length + 1);
    const direct =
      sameToken(token, headers.get('x-telescope-token')) ||
      sameToken(token, bearer);
    return direct || sameToken(token, cookie);
  };
  let forwarder: LocalForwarder;
  try {
    forwarder = new LocalForwarder(store, ownOrigin);
  } catch (error) {
    store.close();
    throw error;
  }
  let agents: ReturnType<typeof createLocalAgentController>;
  try {
    agents = createLocalAgentController({
      store,
      authorizeAdmin: request =>
        localCredential(request.headers) &&
        (['GET', 'HEAD'].includes(request.method) ||
          sameToken(token, request.headers.get('x-telescope-token')) ||
          sameToken(
            token,
            request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1],
          )),
    });
  } catch (error) {
    await forwarder.close();
    store.close();
    throw error;
  }
  let closing = false;
  let storageClosing = false;
  let active:
    | {
        child: ChildProcess;
        job: LocalJob;
        cancelled: boolean;
        deadline: ReturnType<typeof setTimeout>;
        killTimer?: ReturnType<typeof setTimeout>;
      }
    | undefined;

  const closeStorage = (): void => {
    if (storageClosing) return;
    storageClosing = true;
    void forwarder
      .close()
      .catch(() => console.error('Forwarding shutdown did not finish cleanly'))
      .finally(() => store.close());
  };

  const update = (job: LocalJob): void => {
    store.saveJob(job);
  };
  const drain = (): void => {
    if (closing || active) return;
    const job = store
      .jobs()
      .filter(item => item.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return;
    let scriptPath: string | undefined;
    try {
      if (job.script)
        scriptPath = resolveTrustedScript(
          job.script.id,
          job.script.sha256,
        ).path;
    } catch (error) {
      job.status = 'failed';
      job.error = (error as Error).message;
      update(job);
      setImmediate(drain);
      return;
    }
    job.status = 'running';
    update(job);
    const child = fork(path.join(currentDir, 'runWorker.js'), [], {
      detached: process.platform !== 'win32',
      env: { ...process.env, HEADLESS: 'true' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let completed = false;
    let workerResult: TestResult | undefined;
    let timedOut = false;
    const deadline = setTimeout(
      () => {
        if (!active || active.job.id !== job.id) return;
        timedOut = true;
        job.error = 'The local execution deadline expired';
        active.cancelled = false;
        if (child.connected) child.send({ type: 'cancel' });
        active.killTimer = setTimeout(() => terminateWorker(child), 10_000);
      },
      Math.min(
        3_660_000,
        job.script
          ? (job.options.scriptTimeout ??
              Math.max(job.options.timeout ?? DEFAULT_OPTIONS.timeout, 30_000) +
                600_000) + 60_000
          : Math.max(job.options.timeout ?? DEFAULT_OPTIONS.timeout, 30_000) +
              60_000,
      ),
    );
    active = { child, job, deadline, cancelled: false };

    const finish = (result?: TestResult, workerError?: string): void => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      if (active?.killTimer) clearTimeout(active.killTimer);
      const cancellationRequested =
        active?.job.id === job.id && active.cancelled;
      job.status = cancellationRequested
        ? 'cancelled'
        : timedOut
          ? 'failed'
          : result?.success
            ? 'passed'
            : 'failed';
      if (result?.testId) job.testId = result.testId;
      if (result?.resultsPath) job.resultsPath = result.resultsPath;
      if (timedOut) job.error = 'The local execution deadline expired';
      else if (!result?.success)
        job.error =
          result?.error ??
          workerError ??
          job.error ??
          'Browser worker stopped before returning a result';
      else if (!cancellationRequested) delete job.error;
      if (cancellationRequested) job.error = 'Test cancelled';
      update(job);
      active = undefined;
      if (closing) closeStorage();
      else setImmediate(drain);
    };
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const data = message as {
        type?: unknown;
        progress?: RunProgress;
        result?: TestResult;
      };
      if (data.type === 'progress' && data.progress && !completed) {
        job.progress = data.progress;
        job.testId = data.progress.testId;
        job.resultsPath = data.progress.resultsPath;
        if (data.progress.phase === 'finalizing') job.status = 'finalizing';
        update(job);
      } else if (data.type === 'result' && data.result && !completed) {
        workerResult = data.result;
        clearTimeout(deadline);
        if (active && !active.killTimer)
          active.killTimer = setTimeout(() => terminateWorker(child), 10_000);
      }
    });
    child.once('error', error => finish(undefined, error.message));
    child.once('exit', (code, signal) => {
      void (async () => {
        try {
          if (child.pid) await recoverExecutionLease(child.pid);
        } catch (error) {
          finish({
            success: false,
            error: `Worker cleanup failed: ${(error as Error).message}`,
            testId: workerResult?.testId ?? job.testId,
            resultsPath: workerResult?.resultsPath ?? job.resultsPath,
          });
          return;
        }
        finish(
          workerResult,
          `Browser worker exited (${signal ?? code ?? 'unknown'})`,
        );
      })();
    });
    child.send({
      type: 'run',
      options: {
        ...job.options,
        ...(scriptPath ? { script: scriptPath } : {}),
        resultsDir: store.root,
        headless: true,
        html: true,
        openHtml: false,
        list: false,
        uploadUrl: null,
      },
    });
  };

  const cancel = (id: string): LocalJob => {
    const job = store.job(id);
    if (!job) throw new Error('Job not found');
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.error = 'Test cancelled before execution';
      update(job);
    } else if (active?.job.id === id) {
      active.cancelled = true;
      active.job.error = 'Cancellation requested';
      update(active.job);
      if (active.child.connected) active.child.send({ type: 'cancel' });
      if (!active.killTimer)
        active.killTimer = setTimeout(() => {
          if (active?.job.id === id) terminateWorker(active.child);
        }, 10_000);
      return active.job;
    }
    return job;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const requestHost = request.headers.host ?? '';
      if (!/^[a-z0-9.:[\]-]+$/i.test(requestHost)) {
        json(response, 403, { error: 'Invalid Host header' });
        return;
      }
      const parsedHost = new URL(
        `http://${requestHost}`,
      ).hostname.toLowerCase();
      if (!allowedHosts.has(parsedHost)) {
        json(response, 403, {
          error:
            'Host is not allowed; configure TELESCOPE_ALLOWED_HOSTS explicitly',
        });
        return;
      }
      const origin = request.headers.origin;
      if (
        origin &&
        (origin === 'null' ||
          new URL(origin).host.toLowerCase() !== requestHost.toLowerCase())
      ) {
        json(response, 403, { error: 'Origin is not allowed' });
        return;
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        json(response, 403, { error: 'Cross-site requests are not allowed' });
        return;
      }
      const url = new URL(request.url ?? '/', `http://${requestHost}`);
      const method = request.method ?? 'GET';
      if (url.pathname === '/health' && method === 'GET') {
        json(response, 200, {
          status: closing ? 'stopping' : 'ready',
          mode: 'local',
          busy: Boolean(active),
        });
        return;
      }
      if (url.pathname === '/' && method === 'GET') {
        const template = fs.readFileSync(
          path.join(currentDir, 'templates', 'local.ejs'),
          'utf8',
        );
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        response.end(ejs.render(template, { title: 'Telescope local' }));
        return;
      }
      if (
        /^\/(?:agents|run|runs(?:\/.*)?|api\/(?:agents|runs)(?:\/.*)?)$/.test(
          url.pathname,
        )
      ) {
        const result = await agents.handle(
          await webRequest(request, url, MAX_ARCHIVE_BYTES),
        );
        if (result) {
          await webResponse(result, response);
          return;
        }
      }
      if (!url.pathname.startsWith('/api/local/')) {
        json(response, 404, { error: 'Not found' });
        return;
      }
      const headerToken = request.headers['x-telescope-token'];
      const bearerToken =
        request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      const cookieToken = (request.headers.cookie ?? '')
        .split(';')
        .map(value => value.trim())
        .find(value => value.startsWith(`${sessionCookie}=`))
        ?.slice(sessionCookie.length + 1);
      if (
        url.pathname === '/api/local/session' &&
        (method === 'GET' || method === 'POST')
      ) {
        if (
          loopback ||
          sameToken(token, headerToken) ||
          sameToken(token, bearerToken) ||
          sameToken(token, cookieToken)
        ) {
          response.setHeader(
            'Set-Cookie',
            `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          );
          json(response, 200, { token, resultsDir: store.root });
        } else
          json(response, 401, {
            requiresToken: true,
            error: 'Enter the token from the local server startup address',
          });
        return;
      }
      if (
        !sameToken(token, headerToken) &&
        !sameToken(token, bearerToken) &&
        !sameToken(token, cookieToken)
      ) {
        json(response, 401, { error: 'Local session required' });
        return;
      }
      if (
        !['GET', 'HEAD'].includes(method) &&
        !sameToken(token, headerToken) &&
        !sameToken(token, bearerToken)
      ) {
        json(response, 403, {
          error: 'Local session token required for this action',
        });
        return;
      }
      if (closing) {
        json(response, 503, { error: 'Local service is stopping' });
        return;
      }

      const segments = url.pathname
        .slice('/api/local/'.length)
        .split('/')
        .map(decodeURIComponent);
      const [resource, id, action] = segments;
      if (resource === 'scripts' && method === 'GET') {
        json(response, 200, {
          scripts: listTrustedScripts(),
          enabled: Boolean(process.env.TELESCOPE_SCRIPTS_DIR),
        });
        return;
      }
      if (resource === 'forwarding') {
        await webResponse(
          await forwarder.handle(await webRequest(request, url)),
          response,
        );
        return;
      }
      if (resource === 'results' && !id && method === 'GET') {
        json(response, 200, { results: store.results() });
        return;
      }
      if (resource === 'results' && id && !action && method === 'GET') {
        json(
          response,
          200,
          store.result(id, url.searchParams.get('step') ?? undefined),
        );
        return;
      }
      if (
        resource === 'results' &&
        id &&
        action === 'export' &&
        method === 'GET'
      ) {
        const archive = store.exportResult(id);
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${id}.zip"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        try {
          for await (const chunk of archive) {
            if (response.destroyed) break;
            if (!response.write(chunk))
              await new Promise<void>(resolve => {
                const ready = (): void => {
                  response.off('drain', ready);
                  response.off('close', ready);
                  resolve();
                };
                response.once('drain', ready);
                response.once('close', ready);
              });
          }
          if (!response.destroyed) response.end();
        } finally {
          await archive.return();
        }
        return;
      }
      if (resource === 'results' && id && !action && method === 'DELETE') {
        await forwarder.cancelResult(id);
        store.deleteResult(id);
        json(response, 200, { removed: id });
        return;
      }
      if (
        resource === 'artifacts' &&
        id &&
        action &&
        (method === 'GET' || method === 'HEAD')
      ) {
        const relative = segments.slice(2).join('/');
        const filename = store.artifact(id, relative);
        const extension = path.extname(filename).toLowerCase();
        const contentTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webm': 'video/webm',
          '.json': 'application/json',
          '.har': 'application/json',
        };
        const media = ['.png', '.jpg', '.jpeg', '.webm'].includes(extension);
        const size = fs.statSync(filename).size;
        const range = request.headers.range;
        let start = 0;
        let end = size - 1;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (
            !match ||
            Number(match[1]) >= size ||
            (match[2] && Number(match[2]) < Number(match[1]))
          ) {
            response.writeHead(416, {
              'Content-Range': `bytes */${size}`,
              'Cache-Control': 'no-store',
            });
            response.end();
            return;
          }
          start = Number(match[1]);
          end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        }
        response.writeHead(range ? 206 : 200, {
          'Content-Type': contentTypes[extension] ?? 'application/octet-stream',
          'Content-Length': Math.max(0, end - start + 1),
          'Cache-Control': 'no-store',
          'Accept-Ranges': 'bytes',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          ...(range
            ? { 'Content-Range': `bytes ${start}-${end}/${size}` }
            : {}),
          ...(!media
            ? {
                'Content-Disposition': `attachment; filename="${path.basename(filename).replace(/["\r\n]/g, '')}"`,
              }
            : {}),
        });
        if (method === 'HEAD' || size === 0) response.end();
        else {
          const stream = fs.createReadStream(filename, { start, end });
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response);
        }
        return;
      }
      if (resource === 'jobs' && !id && method === 'GET') {
        json(response, 200, { jobs: store.jobs().map(publicJob) });
        return;
      }
      if (resource === 'jobs' && id && !action && method === 'GET') {
        const job = store.job(id);
        if (!job) {
          json(response, 404, { error: 'Job not found' });
          return;
        }
        json(response, 200, { job: publicJob(job) });
        return;
      }
      if (resource === 'jobs' && !id && method === 'POST') {
        const body = z
          .object({
            options: z.unknown(),
            requestId: z.string().min(1).max(200).optional(),
            name: z.string().trim().max(200).optional(),
            description: z.string().max(2000).optional(),
          })
          .strict()
          .parse(await requestJson(request));
        const references = z
          .object({
            scriptId: z.string().max(255).optional(),
            scriptHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .passthrough()
          .parse(body.options);
        const { scriptId, scriptHash, ...testOptions } = references;
        const parsedOptions = parseLocalOptions(testOptions);
        const selected = scriptId
          ? resolveTrustedScript(scriptId, scriptHash)
          : undefined;
        const job = store.createJob(
          parsedOptions,
          body.requestId,
          MAX_QUEUE,
          selected ? { id: selected.id, sha256: selected.sha256 } : undefined,
          { name: body.name, description: body.description },
        );
        json(response, 202, { job: publicJob(job) });
        setImmediate(drain);
        return;
      }
      if (
        resource === 'jobs' &&
        id &&
        action === 'cancel' &&
        method === 'POST'
      ) {
        json(response, 200, { job: publicJob(cancel(id)) });
        return;
      }
      if (resource === 'definitions' && !id && method === 'GET') {
        json(response, 200, { definitions: store.definitions() });
        return;
      }
      if (
        resource === 'definitions' &&
        ((method === 'POST' && !id) || (method === 'PUT' && Boolean(id)))
      ) {
        const body = z
          .object({
            name: z.string().trim().min(1).max(200),
            description: z.string().max(2000).optional(),
            options: z.unknown(),
          })
          .strict()
          .parse(await requestJson(request));
        const references = z
          .object({
            scriptId: z.string().max(255).optional(),
            scriptHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .passthrough()
          .parse(body.options);
        const { scriptId, scriptHash, ...testOptions } = references;
        const selected = scriptId
          ? resolveTrustedScript(scriptId, scriptHash)
          : undefined;
        const definition = store.saveDefinition(
          {
            name: body.name,
            description: body.description,
            options: parseLocalOptions(testOptions),
            script: selected
              ? { id: selected.id, sha256: selected.sha256 }
              : undefined,
          },
          id,
        );
        json(response, id ? 200 : 201, { definition });
        return;
      }
      if (resource === 'definitions' && id && method === 'DELETE') {
        store.deleteDefinition(id);
        json(response, 200, { removed: id });
        return;
      }
      if (resource === 'import' && method === 'POST') {
        const contentType = request.headers['content-type'] ?? '';
        let archive = await requestBytes(request, MAX_ARCHIVE_BYTES);
        let filename = 'upload.zip';
        let name: string | undefined;
        let description: string | undefined;
        if (contentType.startsWith('multipart/form-data')) {
          const wrapped = new Request('http://localhost/import', {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body: new Uint8Array(archive),
          });
          const form = await wrapped.formData();
          const file = form.get('file');
          if (!(file instanceof File))
            throw new Error('Select a ZIP file to import');
          archive = Buffer.from(await file.arrayBuffer());
          filename = file.name;
          name = z
            .string()
            .max(200)
            .optional()
            .parse(form.get('name') ?? undefined);
          description = z
            .string()
            .max(2000)
            .optional()
            .parse(form.get('description') ?? undefined);
        } else if (!contentType.startsWith('application/zip'))
          throw new Error('Expected a ZIP file');
        const receipt = store.importResult(archive, result =>
          forwarder.prepare(
            archive,
            result,
            { filename, source: 'upload', name, description },
            request.headers,
          ),
        );
        const archiveSha256 = crypto
          .createHash('sha256')
          .update(archive)
          .digest('hex');
        json(response, 200, {
          ...receipt,
          success: true,
          zipKey: archiveSha256,
          archiveSha256,
          publicationState: 'committed',
          forwarding: forwarder.list(receipt.testId),
        });
        return;
      }
      json(response, 404, { error: 'Not found' });
    })().catch(error => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const message = (error as Error).message;
      const status =
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        /not found/i.test(message)
          ? 404
          : /exceeds|too large/i.test(message)
            ? 413
            : /queue is full/i.test(message)
              ? 429
              : 400;
      json(response, status, { error: message });
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5000;

  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    agents.close();
    server.close(() => {
      if (!active) closeStorage();
    });
    if (active) {
      cancel(active.job.id);
      const child = active.child;
      setTimeout(() => {
        terminateWorker(child);
        server.closeAllConnections();
      }, 12_000).unref();
    } else closeStorage();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    agents.close();
    await forwarder.close();
    store.close();
    throw error;
  }
  server.on('error', error => {
    console.error(`Local server error: ${error.message}`);
    shutdown();
  });
  const address = `http://${displayHost}:${port}/#token=${encodeURIComponent(token)}`;
  forwarder.start();
  console.log(`Telescope local: ${address}`);
  console.log(`Results directory: ${store.root}`);
  if (options.open !== false) openLocalBrowser(address);
}
