import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as paths from '../../src/utils/paths.js';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
} from '../../src/server/lifecycle.js';

const HIGH_UNUSED_PID = 999_999;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aw-lifecycle-'));
  vi.spyOn(paths, 'getStateRoot').mockReturnValue(tmp);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('writePidFile / readPidFile', () => {
  it('round-trips pid and metadata', async () => {
    const meta = { port: 7400, version: '0.1.0', started: '2026-01-01T00:00:00.000Z' };
    await writePidFile(1234, meta);
    const out = await readPidFile();
    expect(out).not.toBeNull();
    expect(out!.pid).toBe(1234);
    expect(out!.meta).toEqual(meta);
  });

  it('returns null when no PID file exists', async () => {
    const out = await readPidFile();
    expect(out).toBeNull();
  });
});

describe('removePidFile', () => {
  it('removes pid and meta files', async () => {
    await writePidFile(7777, { port: 7400, version: '0.1.0', started: 'x' });
    await removePidFile();
    const out = await readPidFile();
    expect(out).toBeNull();
  });

  it('is idempotent (no error when files missing)', async () => {
    await expect(removePidFile()).resolves.toBeUndefined();
    await expect(removePidFile()).resolves.toBeUndefined();
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for an unused high PID', () => {
    expect(isProcessAlive(HIGH_UNUSED_PID)).toBe(false);
  });

  it('returns false for non-finite or non-positive PIDs', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});

describe('storage path', () => {
  it('writes daemon.pid inside the configured state directory', async () => {
    await writePidFile(4242, { port: 7400, version: '0.1.0', started: 'x' });
    expect(existsSync(path.join(tmp, 'daemon.pid'))).toBe(true);
    expect(existsSync(path.join(tmp, 'daemon.meta.json'))).toBe(true);
    // Touch readdir/stat to verify the directory tree is reasonable.
    expect(statSync(tmp).isDirectory()).toBe(true);
    expect(readdirSync(tmp)).toContain('daemon.pid');
  });
});
