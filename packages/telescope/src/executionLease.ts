import crypto from 'crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { stop as throttleStop } from '@sitespeed.io/throttle';

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function leaseDirectory(): string {
  let scope = os.hostname();
  if (process.platform === 'linux') {
    try {
      scope = readlinkSync('/proc/self/ns/net');
    } catch {
      // Without a readable namespace identifier, coordinate conservatively by host.
    }
  }
  const key = crypto
    .createHash('sha256')
    .update(scope)
    .digest('hex')
    .slice(0, 24);
  return path.join(
    path.resolve(process.env.TELESCOPE_EXECUTION_LEASE_DIR || os.tmpdir()),
    `telescope-execution-${key}`,
  );
}

async function withGuard<T>(
  directory: string,
  action: () => T | Promise<T>,
): Promise<T> {
  const guardPath = path.join(directory, 'guard');
  const token = crypto.randomUUID();
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      descriptor = openSync(guardPath, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await delay(25);
    }
  }
  if (descriptor === undefined) {
    throw new Error(
      `Telescope execution registration is busy. If no Telescope process is running, remove the stale guard at ${guardPath}.`,
    );
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
    return await action();
  } finally {
    closeSync(descriptor);
    // Never remove a guard that has been replaced by an external recovery action.
    try {
      const guard: unknown = JSON.parse(readFileSync(guardPath, 'utf8'));
      if (
        guard !== null &&
        typeof guard === 'object' &&
        'token' in guard &&
        guard.token === token
      ) {
        unlinkSync(guardPath);
      }
    } catch {
      // A missing guard already releases registration; do not touch another owner.
    }
  }
}

/**
 * Restores shaping and removes leases owned by a confirmed-dead child process.
 * The supervisor must share the child's network namespace and lease root.
 */
export async function recoverExecutionLease(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || isLiveProcess(pid)) {
    throw new Error(
      'Execution lease recovery requires a confirmed-dead process',
    );
  }
  const directory = leaseDirectory();
  if (!existsSync(directory)) return;
  await withGuard(directory, async () => {
    for (const filename of readdirSync(directory)) {
      if (!/^lease-[a-f0-9-]+\.json$/.test(filename)) continue;
      const absolute = path.join(directory, filename);
      const lease: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
      if (
        lease === null ||
        typeof lease !== 'object' ||
        !('pid' in lease) ||
        lease.pid !== pid ||
        !('token' in lease) ||
        typeof lease.token !== 'string' ||
        filename !== `lease-${lease.token}.json` ||
        !('throttled' in lease) ||
        typeof lease.throttled !== 'boolean'
      )
        continue;
      if (isLiveProcess(pid))
        throw new Error('Process identity changed during lease recovery');
      if (lease.throttled) await throttleStop();
      unlinkSync(absolute);
    }
  });
}

/**
 * Registers a run in its host/network namespace. Throttled runs are exclusive;
 * ordinary runs may share the scope unless another run owns traffic shaping.
 * @returns An idempotent release function; callers must release during cleanup.
 */
export async function acquireExecutionLease(
  throttled: boolean,
): Promise<() => Promise<void>> {
  const directory = leaseDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const leasePath = path.join(directory, `lease-${token}.json`);
  await withGuard(directory, () => {
    for (const filename of readdirSync(directory)) {
      if (!/^lease-[a-f0-9-]+\.json$/.test(filename)) continue;
      const existingPath = path.join(directory, filename);
      let lease: unknown;
      try {
        lease = JSON.parse(readFileSync(existingPath, 'utf8'));
      } catch {
        throw new Error(
          `Unreadable Telescope execution lease: ${existingPath}`,
        );
      }
      if (
        lease === null ||
        typeof lease !== 'object' ||
        !('pid' in lease) ||
        typeof lease.pid !== 'number' ||
        !Number.isSafeInteger(lease.pid) ||
        lease.pid <= 0 ||
        !('throttled' in lease) ||
        typeof lease.throttled !== 'boolean'
      ) {
        throw new Error(`Invalid Telescope execution lease: ${existingPath}`);
      }
      if (!isLiveProcess(lease.pid)) {
        if (lease.throttled) {
          throw new Error(
            `A previous Telescope process exited while owning network throttling. Restore the network settings, then remove its stale lease at ${existingPath} before running another test.`,
          );
        }
        unlinkSync(existingPath);
        continue;
      }
      if (throttled || lease.throttled) {
        throw new Error(
          'Another Telescope test is using the network namespace. Network-throttled tests require exclusive execution.',
        );
      }
    }
    writeFileSync(
      leasePath,
      JSON.stringify({ pid: process.pid, token, throttled }),
      { flag: 'wx', mode: 0o600 },
    );
  });

  let released = false;
  return async () => {
    if (released) return;
    await withGuard(directory, () => {
      if (!existsSync(leasePath)) return;
      const lease: unknown = JSON.parse(readFileSync(leasePath, 'utf8'));
      if (
        lease !== null &&
        typeof lease === 'object' &&
        'token' in lease &&
        lease.token === token
      ) {
        unlinkSync(leasePath);
      }
    });
    released = true;
  };
}
