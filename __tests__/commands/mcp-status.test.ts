/**
 * `mcp status` must not conclude "not running" from a missing PID file alone —
 * a launchd restart could have left a live daemon unfiled (AW-76).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as paths from '../../src/utils/paths.js';
import { writePidFile } from '../../src/server/lifecycle.js';
import mcpStatus from '../../src/commands/mcp-status.js';

const DEAD_PID = 999_999;

const HEALTH = { version: '0.3.0', pid: 62800, uptime_ms: 4200, port: 7400 };

let tmp: string;
const hadPort = Object.prototype.hasOwnProperty.call(process.env, 'AW_PORT');
const prevPort = process.env.AW_PORT;

function stubHealth(payload: unknown | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      payload === null
        ? Promise.reject(new Error('ECONNREFUSED'))
        : { ok: true, json: async () => payload },
    ),
  );
}

/** `run` is invoked directly; the command takes no args and ignores ctx. */
function run(): ReturnType<typeof mcpStatus.run> {
  return mcpStatus.run({}, {} as never);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aw-mcp-status-'));
  vi.spyOn(paths, 'getStateRoot').mockReturnValue(tmp);
  delete process.env.AW_PORT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (hadPort) process.env.AW_PORT = prevPort;
  rmSync(tmp, { recursive: true, force: true });
});

describe('mcp status', () => {
  it('adopts the health payload when no PID file exists', async () => {
    stubHealth(HEALTH);
    await expect(run()).resolves.toEqual({
      running: true,
      healthy: true,
      orphaned: true,
      pid: 62800,
      port: 7400,
      version: '0.3.0',
      uptime_ms: 4200,
    });
  });

  it('reports the port it probed when nothing answers and no PID file exists', async () => {
    stubHealth(null);
    await expect(run()).resolves.toEqual({ running: false, port: 7400 });
  });

  it('probes the recorded port when the PID file names a dead process', async () => {
    await writePidFile(DEAD_PID, { port: 8123, version: '0.1.0', started: 'x' });
    stubHealth({ ...HEALTH, port: 8123 });
    const result = await run();
    expect(result.running).toBe(true);
    expect(result.orphaned).toBe(true);
    expect(result.port).toBe(8123);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://127.0.0.1:8123/health');
  });

  it('prefers the health payload over the PID file for a live daemon', async () => {
    await writePidFile(process.pid, { port: 7400, version: '0.1.0', started: 'x' });
    stubHealth(HEALTH);
    const result = await run();
    expect(result).toEqual({
      running: true,
      healthy: true,
      pid: 62800,
      port: 7400,
      version: '0.3.0',
      uptime_ms: 4200,
    });
  });

  it('reports a live-but-silent daemon from the PID file, not as orphaned', async () => {
    await writePidFile(process.pid, { port: 7400, version: '0.1.0', started: 'x' });
    stubHealth(null);
    await expect(run()).resolves.toEqual({
      running: true,
      healthy: false,
      pid: process.pid,
      port: 7400,
      version: '0.1.0',
    });
  });
});
