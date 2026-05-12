import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'mini-active-root');

const TEMP_PREFIX = join(tmpdir(), 'aw-test-');

async function withRoot<T>(
  scaffold: (dir: string) => void,
  fn: (activeRoot: string) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(TEMP_PREFIX);
  scaffold(tempDir);

  const hadPrev = Object.prototype.hasOwnProperty.call(
    process.env,
    'ACTIVE_ROOT',
  );
  const prev = process.env.ACTIVE_ROOT;
  process.env.ACTIVE_ROOT = tempDir;

  try {
    return await fn(tempDir);
  } finally {
    if (hadPrev) {
      process.env.ACTIVE_ROOT = prev;
    } else {
      delete process.env.ACTIVE_ROOT;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Create a temp dir, copy the canonical mini-active-root fixture into
 * it, point `ACTIVE_ROOT` at it for the duration of `fn`, then clean up.
 */
export async function withTempActiveRoot<T>(
  fn: (activeRoot: string) => Promise<T>,
): Promise<T> {
  return withRoot(
    (dir) => cpSync(FIXTURE_DIR, dir, { recursive: true }),
    fn,
  );
}

/**
 * Create an empty temp dir as `ACTIVE_ROOT` for the duration of `fn`,
 * then clean up. Useful for testing the bootstrap / first-run path.
 */
export async function withEmptyActiveRoot<T>(
  fn: (activeRoot: string) => Promise<T>,
): Promise<T> {
  return withRoot(() => {}, fn);
}
