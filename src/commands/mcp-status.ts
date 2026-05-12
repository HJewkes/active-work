import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { isProcessAlive, readPidFile } from '../server/lifecycle.js';

/**
 * `aw mcp status` — report whether the daemon is running, plus a
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
});
type Result = z.infer<typeof ResultSchema>;

const HEALTH_TIMEOUT_MS = 500;

interface HealthResponse {
  version: string;
  pid: number;
  uptime_ms: number;
  port: number;
}

async function probeHealth(port: number): Promise<HealthResponse | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export default defineCommand<Args, Result>({
  name: 'mcp.status',
  description: 'Report the MCP HTTP daemon status (pid, port, version, uptime).',
  args: ArgsSchema,
  result: ResultSchema,
  async run() {
    const entry = await readPidFile();
    if (!entry) {
      return { running: false };
    }
    const { pid, meta } = entry;
    const alive = isProcessAlive(pid);
    if (!alive) {
      return { running: false, pid, port: meta.port };
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
