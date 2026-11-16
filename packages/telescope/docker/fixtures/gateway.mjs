import { createServer, request as upstreamRequest } from 'node:http';

const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const upstreamHost = process.env.UPSTREAM_HOST ?? 'app';
const upstreamPort = Number(process.env.UPSTREAM_PORT ?? 3000);
const listenPort = Number(process.env.LISTEN_PORT ?? 3000);
const timeout = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 5000);
if (
  !/^[a-z0-9.-]+$/i.test(upstreamHost) ||
  ![upstreamPort, listenPort].every(
    port => Number.isInteger(port) && port > 0 && port <= 65535,
  ) ||
  !Number.isInteger(timeout) ||
  timeout < 1 ||
  timeout > 120000
) {
  throw new Error('Invalid fixed-upstream gateway configuration');
}

function forwardedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopHeaders.has(name)),
  );
}

// This fixture gateway has one fixed upstream. It is not an open proxy and
// never interprets an absolute URL supplied by an incoming request as a target.
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://gateway');
  const upstream = upstreamRequest(
    {
      hostname: upstreamHost,
      port: upstreamPort,
      path: path.pathname + path.search,
      method: request.method,
      headers: forwardedHeaders(request.headers),
      timeout,
    },
    incoming => {
      response.writeHead(
        incoming.statusCode ?? 502,
        forwardedHeaders(incoming.headers),
      );
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Target unavailable');
    } else {
      response.destroy();
    }
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
  request.pipe(upstream);
});

server.listen(listenPort, '0.0.0.0');
const stop = () => {
  server.close();
  server.closeAllConnections();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
