import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import {
  isProcessAlive,
  probeHealth,
  readPidFile,
  resolveDaemonPort,
} from '../server/lifecycle.js';

/**
 * `active-work mcp status` — report whether the daemon is running, plus a
 * snapshot of `/health` if it answers.
 */

const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  running: z.boolean(),
  pid: z.number().optional(),
  port: z.number().optional(),
  version: z.string().optional(),
  uptime_ms: z.number().optional(),
  healthy: z.boolean().optional(),
  /** Answering `/health` with no PID file naming it — see `removePidFile`. */
  orphaned: z.boolean().optional(),
});
type Result = z.infer<typeof ResultSchema>;

/**
 * No usable PID file: probe the port anyway. Reporting "not running" purely
 * because the file is gone is how a live daemon disappeared from this command
 * while still serving requests (AW-76). `port` on a negative answer names what
 * we actually tried, since a daemon on a non-default `--port` with no file to
 * record it cannot be found from here.
 */
async function statusByPort(port: number): Promise<Result> {
  const health = await probeHealth(port);
  if (!health) return { running: false, port };
  return {
    running: true,
    healthy: true,
    orphaned: true,
    pid: health.pid,
    port: health.port,
    version: health.version,
    uptime_ms: health.uptime_ms,
  };
}

export default defineCommand<Args, Result>({
  name: 'mcp.status',
  description: 'Report the MCP HTTP daemon status (pid, port, version, uptime).',
  args: ArgsSchema,
  result: ResultSchema,
  async run() {
    const entry = await readPidFile();
    if (!entry) {
      return statusByPort(resolveDaemonPort());
    }
    const { pid, meta } = entry;
    if (!isProcessAlive(pid)) {
      // A pre-meta pid file records port 0; fall back to where a daemon would be.
      return statusByPort(meta.port || resolveDaemonPort());
    }
    const health = await probeHealth(meta.port);
    if (health) {
      return {
        running: true,
        pid: health.pid,
        port: health.port,
        version: health.version,
        uptime_ms: health.uptime_ms,
        healthy: true,
      };
    }
    return {
      running: true,
      pid,
      port: meta.port,
      version: meta.version,
      healthy: false,
    };
  },
});
