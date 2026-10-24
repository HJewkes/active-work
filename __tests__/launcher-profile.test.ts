import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors.js';
import {
  CONFIG_DIR_ENV,
  PROFILE_ROOT_ENV,
  applyProfileEnv,
  launchProfileEnv,
  listProfiles,
  profileRoot,
  requireProfileDir,
  resolveProfileDir,
} from '../src/launcher-profile.js';

const exists = () => true;
const missing = () => false;

describe('profileRoot', () => {
  it('defaults to ~/.claude-profiles', () => {
    expect(profileRoot({})).toBe(path.join(homedir(), '.claude-profiles'));
  });

  it('honours an absolute override', () => {
    expect(profileRoot({ [PROFILE_ROOT_ENV]: '/tmp/profiles' })).toBe('/tmp/profiles');
  });

  it('ignores a relative override rather than resolving it against an unknown cwd', () => {
    expect(profileRoot({ [PROFILE_ROOT_ENV]: 'profiles' })).toBe(
      path.join(homedir(), '.claude-profiles'),
    );
  });
});

describe('resolveProfileDir', () => {
  it('joins the profile name onto the root', () => {
    expect(resolveProfileDir('agents', { [PROFILE_ROOT_ENV]: '/tmp/profiles' })).toBe(
      '/tmp/profiles/agents',
    );
  });
});

describe('applyProfileEnv', () => {
  it('leaves the environment alone when the brief declares no profile', () => {
    const result = applyProfileEnv({ PATH: '/bin' }, undefined, exists);
    expect(result.env[CONFIG_DIR_ENV]).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it('points the session at the profile directory', () => {
    const result = applyProfileEnv({ [PROFILE_ROOT_ENV]: '/tmp/profiles' }, 'agents', exists);
    expect(result.env[CONFIG_DIR_ENV]).toBe('/tmp/profiles/agents');
    expect(result.warning).toBeUndefined();
  });

  it('overrides an inherited config dir, because the brief is the more specific instruction', () => {
    const result = applyProfileEnv(
      { [PROFILE_ROOT_ENV]: '/tmp/profiles', [CONFIG_DIR_ENV]: '/somewhere/else' },
      'workout',
      exists,
    );
    expect(result.env[CONFIG_DIR_ENV]).toBe('/tmp/profiles/workout');
  });

  it('warns and launches on the current account when the profile directory is absent', () => {
    const base = { [PROFILE_ROOT_ENV]: '/tmp/profiles', [CONFIG_DIR_ENV]: '/somewhere/else' };
    const result = applyProfileEnv(base, 'ghost', missing);
    expect(result.env[CONFIG_DIR_ENV]).toBe('/somewhere/else');
    expect(result.warning).toContain('/tmp/profiles/ghost');
  });

  it('does not mutate the caller’s environment object', () => {
    const base = { [PROFILE_ROOT_ENV]: '/tmp/profiles' };
    applyProfileEnv(base, 'agents', exists);
    expect(base[CONFIG_DIR_ENV]).toBeUndefined();
  });
});

describe('launchProfileEnv', () => {
  const base = { [PROFILE_ROOT_ENV]: '/tmp/profiles', [CONFIG_DIR_ENV]: '/inherited' };

  it('uses the --profile flag over the brief and the inherited config dir', () => {
    const result = launchProfileEnv(base, { flag: 'server', brief: 'agents' }, exists);

    expect(result.env[CONFIG_DIR_ENV]).toBe('/tmp/profiles/server');
  });

  it('falls back to the brief profile when no flag is given', () => {
    const result = launchProfileEnv(base, { brief: 'agents' }, exists);

    expect(result.env[CONFIG_DIR_ENV]).toBe('/tmp/profiles/agents');
  });

  it('keeps the inherited config dir when neither flag nor brief names a profile', () => {
    const result = launchProfileEnv(base, {}, exists);

    expect(result.env[CONFIG_DIR_ENV]).toBe('/inherited');
  });
});

describe('requireProfileDir', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'aw-profiles-'));
    mkdirSync(path.join(root, 'workout'));
    mkdirSync(path.join(root, 'agents'));
    writeFileSync(path.join(root, 'notes.txt'), '');
    env = { [PROFILE_ROOT_ENV]: root };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the directory of a profile that exists', () => {
    expect(requireProfileDir('agents', env)).toBe(path.join(root, 'agents'));
  });

  it('rejects an unknown name with a usage error listing the profile directories', () => {
    const attempt = () => requireProfileDir('ghost', env);

    expect(attempt).toThrow(UsageError);
    expect(attempt).toThrow(`Available profiles in ${root}: agents, workout`);
  });

  it('rejects a name that escapes the profile root', () => {
    expect(() => requireProfileDir('..', env)).toThrow(UsageError);
  });

  it('reports no profiles when the root does not exist', () => {
    const attempt = () =>
      requireProfileDir('agents', { [PROFILE_ROOT_ENV]: path.join(root, 'nope') });

    expect(attempt).toThrow('(none)');
  });
});

describe('listProfiles', () => {
  it('lists only directories, sorted', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aw-profiles-'));
    mkdirSync(path.join(root, 'server'));
    mkdirSync(path.join(root, 'personal'));
    writeFileSync(path.join(root, 'README'), '');

    const names = listProfiles({ [PROFILE_ROOT_ENV]: root });

    expect(names).toEqual(['personal', 'server']);
    rmSync(root, { recursive: true, force: true });
  });
});
