import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withEmptyActiveRoot, withTempActiveRoot } from './test-helpers.js';

describe('withTempActiveRoot', () => {
  let originalActiveRoot: string | undefined;
  let hadActiveRoot = false;

  beforeEach(() => {
    hadActiveRoot = Object.prototype.hasOwnProperty.call(
      process.env,
      'ACTIVE_ROOT',
    );
    originalActiveRoot = process.env.ACTIVE_ROOT;
    delete process.env.ACTIVE_ROOT;
  });

  afterEach(() => {
    if (hadActiveRoot) {
      process.env.ACTIVE_ROOT = originalActiveRoot;
    } else {
      delete process.env.ACTIVE_ROOT;
    }
  });

  it('returns a fresh directory on each call', async () => {
    const seen: string[] = [];
    await withTempActiveRoot(async (dir) => {
      seen.push(dir);
    });
    await withTempActiveRoot(async (dir) => {
      seen.push(dir);
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('copies the canonical fixture (.schema-version present)', async () => {
    await withTempActiveRoot(async (dir) => {
      const schemaVersion = readFileSync(
        join(dir, '.schema-version'),
        'utf8',
      ).trim();
      expect(schemaVersion).toBe('1');

      const initiatives = readdirSync(dir).filter((n) => !n.startsWith('.'));
      expect(initiatives).toContain('sample-initiative');

      expect(
        existsSync(join(dir, 'sample-initiative', 'brief.md')),
      ).toBe(true);
      expect(
        existsSync(join(dir, 'sample-initiative', 'tasks', 'SI-1.yml')),
      ).toBe(true);
    });
  });

  it('sets ACTIVE_ROOT to the temp dir during fn', async () => {
    let capturedEnv: string | undefined;
    let capturedDir = '';
    await withTempActiveRoot(async (dir) => {
      capturedEnv = process.env.ACTIVE_ROOT;
      capturedDir = dir;
    });
    expect(capturedEnv).toBe(capturedDir);
  });

  it('restores ACTIVE_ROOT after fn (was unset)', async () => {
    expect(process.env.ACTIVE_ROOT).toBeUndefined();
    await withTempActiveRoot(async () => {
      expect(process.env.ACTIVE_ROOT).toBeDefined();
    });
    expect(
      Object.prototype.hasOwnProperty.call(process.env, 'ACTIVE_ROOT'),
    ).toBe(false);
  });

  it('restores prior ACTIVE_ROOT value after fn', async () => {
    process.env.ACTIVE_ROOT = '/tmp/sentinel-prior';
    await withTempActiveRoot(async (dir) => {
      expect(process.env.ACTIVE_ROOT).toBe(dir);
    });
    expect(process.env.ACTIVE_ROOT).toBe('/tmp/sentinel-prior');
  });

  it('removes the temp dir after fn completes', async () => {
    let captured = '';
    await withTempActiveRoot(async (dir) => {
      captured = dir;
      expect(existsSync(captured)).toBe(true);
    });
    expect(existsSync(captured)).toBe(false);
  });

  it('removes the temp dir and restores env even if fn throws', async () => {
    let captured = '';
    await expect(
      withTempActiveRoot(async (dir) => {
        captured = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(captured)).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(process.env, 'ACTIVE_ROOT'),
    ).toBe(false);
  });

  it('returns the value produced by fn', async () => {
    const result = await withTempActiveRoot(async () => 'returned' as const);
    expect(result).toBe('returned');
  });
});

describe('withEmptyActiveRoot', () => {
  let originalActiveRoot: string | undefined;
  let hadActiveRoot = false;

  beforeEach(() => {
    hadActiveRoot = Object.prototype.hasOwnProperty.call(
      process.env,
      'ACTIVE_ROOT',
    );
    originalActiveRoot = process.env.ACTIVE_ROOT;
    delete process.env.ACTIVE_ROOT;
  });

  afterEach(() => {
    if (hadActiveRoot) {
      process.env.ACTIVE_ROOT = originalActiveRoot;
    } else {
      delete process.env.ACTIVE_ROOT;
    }
  });

  it('returns an existing empty directory', async () => {
    await withEmptyActiveRoot(async (dir) => {
      const stats = statSync(dir);
      expect(stats.isDirectory()).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it('sets ACTIVE_ROOT during fn and clears after', async () => {
    let captured = '';
    await withEmptyActiveRoot(async (dir) => {
      captured = dir;
      expect(process.env.ACTIVE_ROOT).toBe(dir);
    });
    expect(existsSync(captured)).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(process.env, 'ACTIVE_ROOT'),
    ).toBe(false);
  });
});
