import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { LockTimeoutError } from '../errors.js';

/**
 * Write `content` to `targetPath` atomically.
 *
 * Strategy: write to a sibling temp file, `fsync` the file, then `rename` to
 * the destination. The temp file lives in the same directory so the rename
 * stays within one filesystem (a requirement for atomic rename on POSIX).
 */
export async function atomicWrite(targetPath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const tempPath = path.join(dir, `${base}.tmp.${suffix}`);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx');
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }

  try {
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
}

/** A holder refreshes its lock every `LOCK_STALE_MS / 2`; one older than this crashed. */
export const LOCK_STALE_MS = 10_000;
/** Longer than `LOCK_STALE_MS`, so a waiter outlasts and reclaims a crashed holder's lock. */
export const LOCK_TIMEOUT_MS = 20_000;
const RETRY_MIN_MS = 10;

export interface FileLockOptions {
  timeoutMs?: number;
}

async function acquireLock(lockTarget: string, timeoutMs: number): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(lockTarget, {
      realpath: false,
      stale: LOCK_STALE_MS,
      retries: {
        retries: Math.ceil(timeoutMs / RETRY_MIN_MS),
        factor: 1.2,
        minTimeout: RETRY_MIN_MS,
        maxTimeout: 100,
        randomize: true,
        maxRetryTime: timeoutMs,
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ELOCKED') throw err;
    throw new LockTimeoutError(
      `Gave up after ${timeoutMs}ms waiting for the lock on ${lockTarget}; another active-work process holds it. Retry later.`,
      { cause: err },
    );
  }
}

/**
 * Run `fn` while holding an advisory lock on `lockTarget`.
 *
 * Uses `proper-lockfile` with `realpath: false` so the target need not exist.
 * Waits up to `timeoutMs` for a busy lock, then throws `LockTimeoutError`.
 * The lock is always released, even when `fn` rejects.
 */
export async function withFileLock<T>(
  lockTarget: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  await fs.mkdir(path.dirname(lockTarget), { recursive: true });
  const release = await acquireLock(lockTarget, options.timeoutMs ?? LOCK_TIMEOUT_MS);
  try {
    return await fn();
  } finally {
    await release();
  }
}
