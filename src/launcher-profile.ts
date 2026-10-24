import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { UsageError } from './errors.js';

export const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const PROFILE_ROOT_ENV = 'CLAUDE_PROFILE_ROOT';

/** Matches the default used by the `claude-profile` shell function. */
export const DEFAULT_PROFILE_ROOT = '.claude-profiles';

export function profileRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[PROFILE_ROOT_ENV];
  if (configured && isAbsolute(configured)) return configured;
  return join(homedir(), DEFAULT_PROFILE_ROOT);
}

export function resolveProfileDir(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(profileRoot(env), profile);
}

export interface ProfileEnvResult {
  env: NodeJS.ProcessEnv;
  /** Set when the profile could not be applied; the caller should surface it. */
  warning?: string;
}

/**
 * Point the spawned session at the initiative's Claude account.
 *
 * A missing profile directory is a warning rather than a failure: the work is
 * still doable on whatever account is already active, and refusing to launch
 * would strand the initiative behind a config problem. The brief wins over an
 * inherited CLAUDE_CONFIG_DIR, since declaring a profile is the more specific
 * instruction.
 */
export function applyProfileEnv(
  base: NodeJS.ProcessEnv,
  profile: string | undefined,
  dirExists: (dir: string) => boolean,
): ProfileEnvResult {
  if (!profile) return { env: { ...base } };

  const dir = resolveProfileDir(profile, base);
  if (!dirExists(dir)) {
    return {
      env: { ...base },
      warning: `profile "${profile}" is declared in the brief but ${dir} does not exist — launching on the current account`,
    };
  }
  return { env: { ...base, [CONFIG_DIR_ENV]: dir } };
}

/**
 * The environment for an `aw` launch: a `--profile` flag beats the brief's
 * `profile:`, which beats an inherited CLAUDE_CONFIG_DIR.
 */
export function launchProfileEnv(
  base: NodeJS.ProcessEnv,
  choice: { flag?: string; brief?: string },
  dirExists: (dir: string) => boolean,
): ProfileEnvResult {
  return applyProfileEnv(base, choice.flag ?? choice.brief, dirExists);
}

/** Names of the profile directories under the profile root, sorted; empty when the root is absent. */
export function listProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = profileRoot(env);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => isDirectory(join(root, name)))
    .sort();
}

/** Follows symlinks; a dangling one is not a profile. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a profile named on the command line, failing loudly when it does not
 * exist. Unlike a brief's profile, a flag is a fresh instruction from the person
 * at the terminal, so launching on another account would silently ignore them.
 */
export function requireProfileDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const known = listProfiles(env);
  if (known.includes(name)) return resolveProfileDir(name, env);
  const available = known.length > 0 ? known.join(', ') : '(none)';
  throw new UsageError(
    `unknown profile "${name}": no directory ${resolveProfileDir(name, env)}. Available profiles in ${profileRoot(env)}: ${available}`,
  );
}
