import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const style = `body{font:18px system-ui,sans-serif;margin:3rem;max-width:50rem}button,a{font:inherit;margin:1rem 1rem 1rem 0}button{padding:.5rem 1rem}#status{color:#365}`;
const script = `
fetch('/api/status').then(response => response.json()).then(data => {
  document.querySelector('#status').textContent = data.ready ? 'Application ready' : 'Waiting';
});
document.querySelector('#add')?.addEventListener('click', () => {
  sessionStorage.setItem('basket', '1');
  document.querySelector('#basket').textContent = 'Added to basket';
});
if (document.querySelector('#checkout')) {
  document.querySelector('#checkout').textContent = sessionStorage.getItem('basket') === '1' ? '1 item in basket' : 'Basket empty';
}
console.info('Docker fixture loaded');
`;

function page(checkout) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Telescope Docker fixture</title><link rel="stylesheet" href="/assets/style.css"></head><body><h1>${checkout ? 'Checkout' : 'Docker fixture product'}</h1><p id="status">Loading application status</p>${checkout ? '<p id="checkout"></p><a href="/product">Back to product</a>' : '<p>A deterministic page with relative assets, API calls, and a checkout navigation.</p><button id="add">Add to basket</button><p id="basket"></p><a href="/checkout">Checkout</a>'}<script src="/assets/app.js" defer></script></body></html>`;
}

/** Starts the deterministic target used by the Docker deployment examples. */
export async function startTarget({ host = '0.0.0.0', port = 3000 } = {}) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
    let status = 200;
    let contentType = 'text/plain; charset=utf-8';
    let body;
    if (pathname === '/' || pathname === '/redirect') {
      response.writeHead(302, {
        Location: '/product',
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }
    if (pathname === '/healthz' || pathname === '/api/status') {
      contentType = 'application/json; charset=utf-8';
      body = JSON.stringify({ ready: true, fixture: 'telescope-docker' });
    } else if (pathname === '/product' || pathname === '/checkout') {
      contentType = 'text/html; charset=utf-8';
      body = page(pathname === '/checkout');
    } else if (pathname === '/assets/style.css') {
      contentType = 'text/css; charset=utf-8';
      body = style;
    } else if (pathname === '/assets/app.js') {
      contentType = 'text/javascript; charset=utf-8';
      body = script;
    } else {
      status = 404;
      body = 'Not found';
    }
    response.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startTarget();
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
