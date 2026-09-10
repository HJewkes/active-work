import { spawn } from 'node:child_process';
import { z } from 'zod';
import { DaemonError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import {
  DEFAULT_DAEMON_PORT,
  isProcessAlive,
  probeHealth,
  readPidFile,
  removePidFile,
} from '../server/lifecycle.js';

/**
 * `active-work mcp restart` — stop the running daemon (if any) then spawn a new
 * detached daemon. Honors the previously-bound port when not overridden.
 *
 * Both waits below are load-bearing (TP-36). A predecessor that has not exited
 * still owns the port, so a successor spawned too early fails to bind and dies
 * silently; the caller was then handed a pid that no longer existed and `mcp
 * status` reported nothing running at all.
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

/** Shutdown awaits an in-flight index refresh, which runs for seconds on a large corpus. */
const SHUTDOWN_TIMEOUT_MS = 15_000;
/** SIGKILL is immediate; this covers scheduler lag only. */
const KILL_TIMEOUT_MS = 3_000;
/** Cold start rebuilds the registry and binds the socket before `/health` answers. */
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

async function waitFor(
  ready: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return ready();
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

async function stopExisting(): Promise<number | undefined> {
  const entry = await readPidFile();
  if (!entry) return undefined;
  const { pid, meta } = entry;
  if (isProcessAlive(pid)) await terminate(pid);
  // Scoped to the pid we killed: a supervisor may have already replaced it.
  await removePidFile(pid);
  return meta.port;
}

async function terminate(pid: number): Promise<void> {
  signal(pid, 'SIGTERM');
  if (await waitFor(() => !isProcessAlive(pid), SHUTDOWN_TIMEOUT_MS)) return;
  signal(pid, 'SIGKILL');
  if (await waitFor(() => !isProcessAlive(pid), KILL_TIMEOUT_MS)) return;
  throw new DaemonError(
    `Daemon pid ${pid} survived SIGTERM and SIGKILL; not starting a second one`,
  );
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

/**
 * A daemon that cannot bind exits within milliseconds and logs nothing, so the
 * death of the child is the fast signal; the timeout only covers a child that
 * lives but never becomes answerable.
 */
async function confirmStarted(pid: number, port: number): Promise<void> {
  const up = await waitFor(async () => {
    if (!isProcessAlive(pid)) {
      throw new DaemonError(
        `Spawned pid ${pid} exited immediately — port ${port} is likely still held. See \`active-work mcp logs\``,
      );
    }
    return (await probeHealth(port)) !== null;
  }, STARTUP_TIMEOUT_MS);
  if (up) return;
  throw new DaemonError(
    `Spawned pid ${pid} is running but nothing answered http://127.0.0.1:${port}/health within ${STARTUP_TIMEOUT_MS}ms`,
  );
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
    const port = args.port ?? prevPort ?? DEFAULT_DAEMON_PORT;
    const spawned = detachedSpawn(port);
    await confirmStarted(spawned.pid, port);
    return spawned;
  },
});
