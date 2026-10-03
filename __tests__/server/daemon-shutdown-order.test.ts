/**
 * CC-299: the daemon's close() is the shutdown-completion signal, so it must
 * resolve only after the PID file is gone. Runs in-process on an ephemeral port.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daemonPaths, silentLogger } from '@titan-design/daemon';
import { runDaemon, startActiveWorkDaemon } from '../../src/server/daemon.js';
import type * as RefreshModule from '../../src/session-index/refresh.js';
import { refreshLockHolderPath } from '../../src/session-index/refresh.js';
import { assertSafeToRemove, withEmptyActiveRoot } from '../setup/test-helpers.js';

const pass = vi.hoisted(() => {
  let reached!: () => void;
  return {
    atYield: new Promise<void>((resolve) => (reached = resolve)),
    reached: () => reached(),
  };
});

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../../src/server/logger.js', () => ({ getLogger: () => log }));

// A related request that never finishes: the pass's yield point would wait out the gate.
vi.mock('../../src/session-index/reader-gate.js', () => ({
  readerGate: {
    enter: () => () => {},
    idle: (_maxWaitMs: number) => new Promise<void>((resolve) => setTimeout(resolve, 60_000)),
  },
}));

// A pass that reaches its first yield point and keeps yielding, like a chunked episode sweep.
vi.mock('../../src/session-index/refresh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RefreshModule>()),
  runRefresh: async (options: RefreshModule.RefreshOptions) => {
    for (;;) {
      const yielded = options.yieldPoint!();
      pass.reached();
      await yielded;
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The message of each logged record, whether pino got `(fields, msg)` or `(msg)`. */
function messages(fn: typeof log.info): string[] {
  return fn.mock.calls.map((args) => args.find((arg): arg is string => typeof arg === 'string')!);
}

describe('daemon shutdown ordering', () => {
  it('resolves close() only after the PID file is removed', async () => {
    await withEmptyActiveRoot(async () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
      try {
        const handle = await startActiveWorkDaemon({ port: 0, stateDir, logger: silentLogger });
        const { pidFile } = daemonPaths(stateDir);
        expect(existsSync(pidFile)).toBe(true);

        await handle.close();

        expect(existsSync(pidFile)).toBe(false);
      } finally {
        assertSafeToRemove(stateDir);
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  it('a SIGTERM during a pass blocked at its yield point stops well under the cap', async () => {
    const capMs = 5_000;
    vi.stubEnv('AW_SHUTDOWN_INDEX_MS', String(capMs));
    vi.stubEnv('CLAUDE_CONFIG_DIRS', path.join(os.tmpdir(), 'aw-no-transcripts'));
    await withEmptyActiveRoot(async () => {
      const running = runDaemon({ port: 0 });
      await pass.atYield;

      const started = Date.now();
      process.emit('SIGTERM', 'SIGTERM');
      await running;
      const elapsedMs = Date.now() - started;

      expect(elapsedMs).toBeLessThan(capMs);
      expect(messages(log.info)).toContain('stopped');
      expect(messages(log.warn)).not.toContain(
        'session index watcher still closing; stopping anyway',
      );
      expect(messages(log.warn)).not.toContain('session index refresh failed');
      expect(existsSync(refreshLockHolderPath())).toBe(false);
    });
  });
});
