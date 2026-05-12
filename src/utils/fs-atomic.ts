import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

/**
 * Write `content` to `targetPath` atomically.
 *
 * Strategy: write to a sibling temp file, `fsync` the file, then `rename` to
 * the destination. The temp file lives in the same directory so the rename
 * stays within one filesystem (a requirement for atomic rename on POSIX).
 */
export async function atomicWrite(
  targetPath: string,
  content: string | Buffer,
): Promise<void> {
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

/**
 * Run `fn` while holding an advisory lock on `lockTarget`.
 *
 * Uses `proper-lockfile` with `realpath: false` so the target need not exist.
 * The lock is always released, even when `fn` rejects.
 */
export async function withFileLock<T>(
  lockTarget: string,
  fn: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(lockTarget), { recursive: true });
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    retries: { retries: 5, factor: 1.5, minTimeout: 50 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
