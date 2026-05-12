import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';

const PROJECT_NAME = 'active-work';

function paths(): ReturnType<typeof envPaths> {
  return envPaths(PROJECT_NAME, { suffix: '' });
}

/**
 * Replace a leading `~` with the user's home directory.
 *
 * Returns the input unchanged when it does not start with `~`.
 */
export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the root directory for initiative data.
 *
 * Honors `ACTIVE_ROOT` (with `~` expansion) when set; otherwise falls back to
 * the XDG data path provided by `env-paths`.
 */
export function getActiveRoot(): string {
  const override = process.env.ACTIVE_ROOT;
  if (override && override.length > 0) {
    return path.resolve(expandTilde(override));
  }
  return paths().data;
}

/** Resolve the XDG state directory used for ephemeral runtime state. */
export function getStateRoot(): string {
  return paths().log;
}

/** Resolve the XDG config directory used for user-level config files. */
export function getConfigRoot(): string {
  return paths().config;
}

/** Resolve the XDG cache directory. */
export function getCacheRoot(): string {
  return paths().cache;
}

/** Resolve the directory for a single initiative by slug. */
export function getInitiativeDir(slug: string): string {
  return path.join(getActiveRoot(), slug);
}

/** Resolve the path of the advisory lockfile for an initiative. */
export function getLockPath(slug: string): string {
  return path.join(getInitiativeDir(slug), '.lock');
}
