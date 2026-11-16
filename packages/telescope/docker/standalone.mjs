import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTarget } from './fixtures/target.mjs';

// Keep the fixture in this container to demonstrate loopback target access.
// The ordinary image entry point still accepts `local` directly for real apps.
const fixture = await startTarget({ host: '127.0.0.1', port: 3000 });
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const child = spawn(
  process.execPath,
  [
    cli,
    'local',
    '--host',
    '0.0.0.0',
    '--port',
    '4321',
    '--resultsDir',
    '/data',
    '--no-open',
  ],
  { stdio: 'inherit', env: process.env },
);
let stopping = false;
let finished = false;
let killTimer;

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(killTimer);
  fixture.close();
  fixture.closeAllConnections();
  process.exitCode = code;
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  killTimer = setTimeout(() => child.kill('SIGKILL'), 25000);
  killTimer.unref();
}

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
child.once('error', error => {
  console.error('Local workspace could not start:', error.message);
  finish(1);
});
child.once('exit', (code, signal) =>
  finish(code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1)),
);
