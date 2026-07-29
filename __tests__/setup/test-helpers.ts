import { mkdtempSync, cpSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'mini-active-root');

const TEMP_PREFIX = join(tmpdir(), 'aw-test-');

/**
 * Refuse to recursively delete anything that is not one of our own temp dirs.
 *
 * `mkdtempSync` already guarantees a fresh path, so under normal control flow
 * this can never fire. It exists because the consequence of it ever being
 * wrong is unrecoverable: an agent that set `XDG_DATA_HOME` expecting
 * redirection (darwin's `env-paths` ignores it) once created ten synthetic
 * initiatives in the operator's LIVE root, and a sibling bug deleted
 * `~/.claude/skills/active-work/` mid-session. A guard on the destructive step
 * costs nothing and turns a silent catastrophe into a failed test.
 *
 * Compares realpaths because macOS resolves `/tmp` through `/private/tmp`, so
 * a plain prefix match on the un-resolved path would reject valid temp dirs.
 */
export function assertSafeToRemove(dir: string): void {
  const resolved = realpathSync(resolve(dir));
  const tempBase = realpathSync(tmpdir());
  const withinTemp = resolved.startsWith(tempBase + sep);
  const looksLikeOurs = resolved.includes('aw-test-');
  if (!withinTemp || !looksLikeOurs) {
    throw new Error(
      `test-helpers refused to delete ${resolved}: not an aw-test- temp dir ` +
        `under ${tempBase}. Tests must never write to or remove the real ` +
        `active root — override it with ACTIVE_ROOT, never XDG_DATA_HOME.`,
    );
  }
}

async function withRoot<T>(
  scaffold: (dir: string) => void,
  fn: (activeRoot: string) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(TEMP_PREFIX);
  scaffold(tempDir);

  const hadPrev = Object.prototype.hasOwnProperty.call(process.env, 'ACTIVE_ROOT');
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
    assertSafeToRemove(tempDir);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Create a temp dir, copy the canonical mini-active-root fixture into
 * it, point `ACTIVE_ROOT` at it for the duration of `fn`, then clean up.
 */
export async function withTempActiveRoot<T>(fn: (activeRoot: string) => Promise<T>): Promise<T> {
  return withRoot((dir) => cpSync(FIXTURE_DIR, dir, { recursive: true }), fn);
}

/**
 * Create an empty temp dir as `ACTIVE_ROOT` for the duration of `fn`,
 * then clean up. Useful for testing the bootstrap / first-run path.
 */
export async function withEmptyActiveRoot<T>(fn: (activeRoot: string) => Promise<T>): Promise<T> {
  return withRoot(() => {}, fn);
}
