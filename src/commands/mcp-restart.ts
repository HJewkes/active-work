import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import {
  isProcessAlive,
  readPidFile,
  removePidFile,
} from '../server/lifecycle.js';

/**
 * `active-work mcp restart` — stop the running daemon (if any) then spawn a new
 * detached daemon. Honors the previously-bound port when not overridden.
 */

const ArgsSchema = z.object({
  port: z.number().int().positive().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  pid: z.number(),
  port: z.number(),
});
type Result = z.infer<typeof ResultSchema>;

const SHUTDOWN_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;
const DEFAULT_PORT = 7400;

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function stopExisting(): Promise<number | undefined> {
  const entry = await readPidFile();
  if (!entry) return undefined;
  const { pid, meta } = entry;
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
    await waitForExit(pid, SHUTDOWN_TIMEOUT_MS);
  }
  await removePidFile();
  return meta.port;
}

function detachedSpawn(port: number): { pid: number; port: number } {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error('Cannot determine CLI entrypoint for restart');
  }
  const child = spawn(process.execPath, [entry, 'mcp', 'serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return { pid: child.pid ?? -1, port };
}

export default defineCommand<Args, Result>({
  name: 'mcp.restart',
  description: 'Restart the MCP HTTP daemon (stop, then spawn a fresh detached instance).',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      port: {
        long: '--port',
        description: 'Port for the restarted daemon (default: previous port or 7400).',
      },
    },
  },
  async run(args) {
    const prevPort = await stopExisting();
    const port = args.port ?? prevPort ?? DEFAULT_PORT;
    return detachedSpawn(port);
  },
});
