/**
 * Health endpoint state.
 *
 * `startedAt` is captured at module load so `/health` can report
 * uptime relative to daemon start without threading it through the
 * route builder.
 */

// TODO: read version from package.json at build time; hardcoded for v0.
export const DAEMON_VERSION = '0.1.0';

export const startedAt = Date.now();

/**
 * Session-index state, mirrored onto `/health` so `miner status` can report
 * what the daemon is doing without a second endpoint — and without the CLI
 * needing to reach into another process. `null` when this daemon is not
 * indexing.
 */
export interface HealthIndexState {
  indexing: boolean;
  pending: boolean;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
}

export interface HealthPayload {
  ok: true;
  version: string;
  pid: number;
  uptime_ms: number;
  port: number;
  index: HealthIndexState | null;
}

export function buildHealthPayload(
  port: number,
  index: HealthIndexState | null = null,
): HealthPayload {
  return {
    ok: true,
    version: DAEMON_VERSION,
    pid: process.pid,
    uptime_ms: Date.now() - startedAt,
    port,
    index,
  };
}
