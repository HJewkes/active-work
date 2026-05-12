import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expandTilde,
  getActiveRoot,
  getCacheRoot,
  getConfigRoot,
  getInitiativeDir,
  getLockPath,
  getStateRoot,
} from '../../src/utils/paths.js';

const expected = envPaths('active-work', { suffix: '' });

describe('expandTilde', () => {
  it('expands a leading tilde to the home directory', () => {
    expect(expandTilde('~')).toBe(os.homedir());
    expect(expandTilde('~/foo/bar')).toBe(path.join(os.homedir(), 'foo/bar'));
  });

  it('passes other paths through unchanged', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path');
    expect(expandTilde('relative/path')).toBe('relative/path');
    expect(expandTilde('~not-tilde')).toBe('~not-tilde');
  });
});

describe('path roots', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to env-paths data dir for getActiveRoot', () => {
    vi.stubEnv('ACTIVE_ROOT', '');
    expect(getActiveRoot()).toBe(expected.data);
  });

  it('honors ACTIVE_ROOT override', () => {
    vi.stubEnv('ACTIVE_ROOT', '/tmp/active-root-test');
    expect(getActiveRoot()).toBe('/tmp/active-root-test');
  });

  it('expands tilde in ACTIVE_ROOT override', () => {
    vi.stubEnv('ACTIVE_ROOT', '~/active-root-test');
    expect(getActiveRoot()).toBe(path.join(os.homedir(), 'active-root-test'));
  });

  it('returns env-paths state, config, and cache roots', () => {
    expect(getStateRoot()).toBe(expected.log);
    expect(getConfigRoot()).toBe(expected.config);
    expect(getCacheRoot()).toBe(expected.cache);
  });
});

describe('initiative paths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds the initiative directory under the active root', () => {
    vi.stubEnv('ACTIVE_ROOT', '/tmp/aw-paths-test');
    expect(getInitiativeDir('foo')).toBe('/tmp/aw-paths-test/foo');
  });

  it('builds the lockfile path inside the initiative directory', () => {
    vi.stubEnv('ACTIVE_ROOT', '/tmp/aw-paths-test');
    expect(getLockPath('foo')).toBe('/tmp/aw-paths-test/foo/.lock');
  });
});
