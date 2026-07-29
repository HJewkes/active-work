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
  resolveDaemonPort,
  probeHealth,
  DEFAULT_DAEMON_PORT,
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
  it('removes pid and meta files when the file names the given pid', async () => {
    await writePidFile(7777, { port: 7400, version: '0.1.0', started: 'x' });
    await expect(removePidFile(7777)).resolves.toBe(true);
    expect(await readPidFile()).toBeNull();
  });

  it('leaves a successor pid file alone (AW-76)', async () => {
    await writePidFile(62648, { port: 7400, version: '0.1.0', started: 'x' });
    // launchd restart: the successor files itself before the departing
    // instance's shutdown handler runs.
    await writePidFile(62800, { port: 7400, version: '0.1.0', started: 'y' });

    await expect(removePidFile(62648)).resolves.toBe(false);

    const out = await readPidFile();
    expect(out!.pid).toBe(62800);
    expect(out!.meta.started).toBe('y');
  });

  it('is idempotent (no error when files missing)', async () => {
    await expect(removePidFile(1)).resolves.toBe(false);
    await expect(removePidFile(1)).resolves.toBe(false);
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

describe('resolveDaemonPort', () => {
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'AW_PORT');
  const prevEnv = process.env.AW_PORT;

  afterEach(() => {
    if (hadEnv) process.env.AW_PORT = prevEnv;
    else delete process.env.AW_PORT;
  });

  it('defaults to 7400 when AW_PORT is unset', () => {
    delete process.env.AW_PORT;
    expect(resolveDaemonPort()).toBe(DEFAULT_DAEMON_PORT);
  });

  it('honors AW_PORT', () => {
    process.env.AW_PORT = '9123';
    expect(resolveDaemonPort()).toBe(9123);
  });

  it('falls back to the default when AW_PORT is not a number', () => {
    process.env.AW_PORT = 'nope';
    expect(resolveDaemonPort()).toBe(DEFAULT_DAEMON_PORT);
  });
});

describe('probeHealth', () => {
  it('returns the parsed health payload', async () => {
    const payload = { version: '0.1.0', pid: 62800, uptime_ms: 12, port: 7400 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
    await expect(probeHealth(7400)).resolves.toEqual(payload);
    vi.unstubAllGlobals();
  });

  it('returns null when nothing is listening', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(probeHealth(7400)).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('returns null on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(probeHealth(7400)).resolves.toBeNull();
    vi.unstubAllGlobals();
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
