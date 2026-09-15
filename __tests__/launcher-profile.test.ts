import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_DIR_ENV,
  PROFILE_ROOT_ENV,
  applyProfileEnv,
  profileRoot,
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
