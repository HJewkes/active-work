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

export interface HealthPayload {
  ok: true;
  version: string;
  pid: number;
  uptime_ms: number;
  port: number;
}

export function buildHealthPayload(port: number): HealthPayload {
  return {
    ok: true,
    version: DAEMON_VERSION,
    pid: process.pid,
    uptime_ms: Date.now() - startedAt,
    port,
  };
}
