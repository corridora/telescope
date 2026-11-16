import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { BrowserConfig } from '../src/browsers.js';
import { ResultManifestSchema } from '../src/contracts.js';
import { acquireExecutionLease } from '../src/executionLease.js';
import { TestRunner } from '../src/testRunner.js';
import type { LaunchOptions, SavedConfig } from '../src/types.js';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function registeredLeaseFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { recursive: true })
    .filter(filename =>
      /^lease-[a-f0-9-]+\.json$/.test(path.basename(filename)),
    );
}

describe.skipIf(process.platform === 'win32')('Runner startup deadline', () => {
  it('terminates a stalled startup executable and retains a failed capture while releasing its profile and lease', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'telescope-runner-deadline-'),
    );
    const leaseRoot = path.join(directory, 'private leases');
    const helper = path.join(directory, 'stalled-startup.mjs');
    const marker = path.join(directory, 'helper-process.json');
    const originalLeaseRoot = process.env.TELESCOPE_EXECUTION_LEASE_DIR;
    process.env.TELESCOPE_EXECUTION_LEASE_DIR = leaseRoot;
    const timeout = 500;
    const options: LaunchOptions = {
      url: 'http://localhost:3000/',
      resultsDir: path.join(directory, 'saved results'),
      timeout,
      headless: true,
    };
    const config = {
      ...new BrowserConfig().getBrowserConfig('chromium', options),
      executablePath: helper,
    };
    const runner = new TestRunner(options, config);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let helperPid: number | undefined;
    const markerPid = (): number | undefined => {
      if (!fs.existsSync(marker)) return undefined;
      const record = JSON.parse(fs.readFileSync(marker, 'utf8')) as {
        pid?: number;
      };
      return Number.isSafeInteger(record.pid) && record.pid! > 0
        ? record.pid
        : undefined;
    };
    const stopHelper = (): void => {
      const pid = helperPid ?? markerPid();
      if (pid && processAlive(pid)) process.kill(pid, 'SIGKILL');
    };

    try {
      fs.writeFileSync(
        helper,
        `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,profileExists:fs.existsSync(${JSON.stringify(runner.paths.temporaryContext)})}), {flag:'wx',mode:0o600});\nsetInterval(() => {}, 1000);\n`,
        { mode: 0o700, flag: 'wx' },
      );
      await runner.saveConfig();
      // This fails closed if the launch timeout regresses: no stalled child is
      // allowed to remain alive for Playwright's much longer default deadline.
      watchdog = setTimeout(stopHelper, 8000);
      const startedAt = performance.now();
      let startupError: unknown;
      try {
        await runner.setupTest();
      } catch (error) {
        startupError = error;
      }
      const elapsedMs = performance.now() - startedAt;
      clearTimeout(watchdog);
      expect(startupError).toBeInstanceOf(Error);
      expect((startupError as Error).name).toBe('TimeoutError');
      expect((startupError as Error).message).toContain(
        `Timeout ${timeout}ms exceeded`,
      );
      expect(elapsedMs).toBeLessThan(5000);
      expect(fs.existsSync(marker)).toBe(true);
      const recorded = JSON.parse(fs.readFileSync(marker, 'utf8')) as {
        pid: number;
        profileExists: boolean;
      };
      helperPid = recorded.pid;
      expect(recorded.profileExists).toBe(true);
      const childExitDeadline = Date.now() + 2000;
      while (processAlive(helperPid) && Date.now() < childExitDeadline)
        await delay(10);
      expect(processAlive(helperPid)).toBe(false);
      expect(registeredLeaseFiles(leaseRoot)).toHaveLength(1);

      await runner.finalizeFailure(startupError);
      await runner.cleanup();
      const capture = ResultManifestSchema.parse(
        JSON.parse(
          fs.readFileSync(
            path.join(runner.paths.results, 'result.json'),
            'utf8',
          ),
        ),
      );
      const saved = JSON.parse(
        fs.readFileSync(path.join(runner.paths.results, 'config.json'), 'utf8'),
      ) as SavedConfig;
      expect(capture).toMatchObject({
        testId: runner.TESTID,
        status: 'failed',
        error: (startupError as Error).message,
      });
      expect(capture.finishedAt).toBeTruthy();
      expect(saved).toMatchObject({
        testId: runner.TESTID,
        options: { timeout, resultsDir: options.resultsDir },
        url: options.url,
      });
      expect(path.isAbsolute(runner.paths.results)).toBe(true);
      expect(fs.existsSync(runner.paths.results)).toBe(true);
      for (const filename of [
        'config.json',
        'console.json',
        'resources.json',
      ]) {
        const bytes = fs.readFileSync(
          path.join(runner.paths.results, filename),
        );
        expect(capture.artifacts[filename]).toEqual({
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        });
      }
      expect(fs.existsSync(runner.paths.temporaryContext)).toBe(false);
      expect(registeredLeaseFiles(leaseRoot)).toEqual([]);
      // Registration remains usable after cleanup; an abandoned guard cannot
      // make the next normal execution fail despite having no live browser.
      const release = await acquireExecutionLease(false);
      await release();
      expect(registeredLeaseFiles(leaseRoot)).toEqual([]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      stopHelper();
      await runner.cleanup().catch(() => undefined);
      if (originalLeaseRoot === undefined)
        delete process.env.TELESCOPE_EXECUTION_LEASE_DIR;
      else process.env.TELESCOPE_EXECUTION_LEASE_DIR = originalLeaseRoot;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 12_000);
});
