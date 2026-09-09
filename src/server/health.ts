/**
 * Health state active-work adds on top of `@titan-design/daemon`'s payload.
 *
 * The package builds `{ok, version, pid, uptime_ms, port}` and merges a
 * product extension into it; `index` below is that extension. `startedAt` is
 * captured at module load so uptime is measured from process start rather than
 * from when the app happened to be built.
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
