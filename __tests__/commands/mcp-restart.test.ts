/**
 * `mcp restart` must not report a pid it never confirmed (TP-36). A successor
 * spawned onto a port the predecessor still holds fails to bind and exits
 * silently, so the old code returned a pid that was already gone and left the
 * caller with no daemon at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as paths from '../../src/utils/paths.js';
import { writePidFile } from '../../src/server/lifecycle.js';
import mcpRestart from '../../src/commands/mcp-restart.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: SPAWNED_PID, unref: () => {} })),
}));

/** Must be a pid that is genuinely alive: restart now waits on the child, not just on `/health`. */
const SPAWNED_PID = process.pid;
/** Above macOS's pid ceiling, so `isProcessAlive` is false without racing a real process. */
const DEAD_PID = 999_999;

let tmp: string;
const hadPort = Object.prototype.hasOwnProperty.call(process.env, 'AW_PORT');
const prevPort = process.env.AW_PORT;

/** `probeHealth` is a bare fetch; null answers mean nothing is listening. */
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

function run(): ReturnType<typeof mcpRestart.run> {
  return mcpRestart.run({}, {} as never);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aw-mcp-restart-'));
  vi.spyOn(paths, 'getStateRoot').mockReturnValue(tmp);
  vi.mocked(spawn).mockClear();
  delete process.env.AW_PORT;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (hadPort) process.env.AW_PORT = prevPort;
  rmSync(tmp, { recursive: true, force: true });
});

describe('mcp restart', () => {
  it('reports the successor once it answers /health', async () => {
    await writePidFile(DEAD_PID, { port: 8123, version: '0.1.0', started: 'x' });
    stubHealth({ version: '0.1.0', pid: SPAWNED_PID, uptime_ms: 10, port: 8123 });

    await expect(run()).resolves.toEqual({ pid: SPAWNED_PID, port: 8123 });
  });

  it('fails loudly when the successor dies instead of reporting its pid', async () => {
    await writePidFile(DEAD_PID, { port: 8123, version: '0.1.0', started: 'x' });
    stubHealth(null);
    vi.mocked(spawn).mockReturnValueOnce({ pid: DEAD_PID, unref: () => {} } as never);

    await expect(run()).rejects.toThrow(/exited immediately/);
    expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
  });

  it('reuses the recorded port rather than the default', async () => {
    await writePidFile(DEAD_PID, { port: 8123, version: '0.1.0', started: 'x' });
    stubHealth({ version: '0.1.0', pid: SPAWNED_PID, uptime_ms: 10, port: 8123 });

    await run();

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['mcp', 'serve', '--port', '8123']));
  });
});
