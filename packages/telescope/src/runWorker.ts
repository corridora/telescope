import type { LaunchOptions, TestResult } from './types.js';

process.env.HEADLESS = process.env.HEADLESS ?? 'true';
const abortController = new AbortController();
let started = false;

/** Sends an IPC result before disconnecting so the supervisor can retain its capture. */
function finish(result: TestResult): void {
  if (process.send) {
    process.send({ type: 'result', result }, () => {
      if (process.connected) process.disconnect?.();
      process.exitCode = 0;
    });
  } else {
    process.exitCode = result.success ? 0 : 1;
  }
}

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const data = message as { type?: unknown; options?: LaunchOptions };
  if (data.type === 'cancel') {
    abortController.abort(new Error('Test cancelled'));
    return;
  }
  if (data.type !== 'run' || started || !data.options) return;
  started = true;
  const options = data.options;
  void (async () => {
    const { launchTest } = await import('./index.js');
    const result = await launchTest({
      ...options,
      signal: abortController.signal,
      onProgress: progress => {
        if (process.connected) process.send?.({ type: 'progress', progress });
      },
    });
    finish(result);
  })().catch(error =>
    finish({ success: false, error: (error as Error).message }),
  );
});

process.on('SIGTERM', () => abortController.abort(new Error('Worker stopped')));
process.on('SIGINT', () => abortController.abort(new Error('Worker stopped')));
process.on('disconnect', () =>
  abortController.abort(new Error('Supervisor disconnected')),
);
