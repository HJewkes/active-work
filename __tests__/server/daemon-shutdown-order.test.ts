/**
 * CC-299: the daemon's close() is the shutdown-completion signal, so it must
 * resolve only after the PID file is gone. Runs in-process on an ephemeral port.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daemonPaths, silentLogger } from '@titan-design/daemon';
import { startActiveWorkDaemon } from '../../src/server/daemon.js';
import { assertSafeToRemove, withEmptyActiveRoot } from '../setup/test-helpers.js';

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
});
