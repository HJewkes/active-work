import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import {
  isProcessAlive,
  readPidFile,
  removePidFile,
} from '../server/lifecycle.js';

/**
 * `active-work mcp stop` — send SIGTERM to the daemon and wait for it to exit.
 *
 * Returns `{ stopped: false, reason: 'not running' }` when no PID file
 * exists or the recorded process has already died.
 */

const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.union([
  z.object({ stopped: z.literal(true), pid: z.number() }),
  z.object({ stopped: z.literal(false), reason: z.string() }),
]);
type Result = z.infer<typeof ResultSchema>;

const SHUTDOWN_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid);
}

export default defineCommand<Args, Result>({
  name: 'mcp.stop',
  description: 'Stop the running MCP HTTP daemon (sends SIGTERM, waits for exit).',
  args: ArgsSchema,
  result: ResultSchema,
  async run() {
    const pidEntry = await readPidFile();
    if (!pidEntry) {
      return { stopped: false, reason: 'not running' };
    }
    const { pid } = pidEntry;
    if (!isProcessAlive(pid)) {
      await removePidFile();
      return { stopped: false, reason: 'not running' };
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        await removePidFile();
        return { stopped: false, reason: 'not running' };
      }
      throw err;
    }
    await waitForExit(pid, SHUTDOWN_TIMEOUT_MS);
    await removePidFile();
    return { stopped: true, pid };
  },
});
