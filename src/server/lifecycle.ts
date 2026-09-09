/**
 * active-work's binding of `@titan-design/daemon`'s pid lifecycle (AW-a).
 *
 * The package takes an explicit `DaemonPaths` so one process can own several
 * daemons; active-work has exactly one, rooted at `getStateRoot()`. Binding
 * that here is why the eight modules importing `writePidFile`, `readPidFile`,
 * `removePidFile`, `probeHealth` and friends are unchanged.
 *
 * `resolveDaemonPort` and the typed `DaemonHealth` stay local: the port comes
 * from active-work's own `AW_PORT` convention, and the package deliberately
 * types `/health` as an open record because the index payload below is this
 * product's extension rather than part of the daemon contract.
 */
import {
  daemonPaths,
  probeHealth as pkgProbeHealth,
  readPidFile as pkgReadPidFile,
  removePidFile as pkgRemovePidFile,
  writePidFile as pkgWritePidFile,
  type DaemonPaths,
} from '@titan-design/daemon';
import { getStateRoot } from '../utils/paths.js';
import type { HealthIndexState } from './health.js';

export { DEFAULT_DAEMON_PORT, getProcessCommand, isProcessAlive } from '@titan-design/daemon';
export type { DaemonMeta, PidFileContents } from '@titan-design/daemon';

/** Resolved per call rather than once, because tests move the state root between cases. */
export function paths(): DaemonPaths {
  return daemonPaths(getStateRoot());
}

export async function writePidFile(
  pid: number,
  meta: { port: number; version: string; started: string },
): Promise<void> {
  await pkgWritePidFile(paths(), pid, meta);
}

export async function readPidFile(): ReturnType<typeof pkgReadPidFile> {
  return pkgReadPidFile(paths());
}

export async function removePidFile(expectedPid: number): Promise<boolean> {
  return pkgRemovePidFile(paths(), expectedPid);
}

/**
 * The port a daemon would be listening on absent an explicit `--port`.
 *
 * Callers that have lost the PID file still need somewhere to aim a health
 * probe; the installed launchd/systemd unit runs `mcp serve` with no port
 * argument, so this is the port in practice.
 */
export function resolveDaemonPort(): number {
  const envPort = process.env.AW_PORT;
  if (envPort) {
    const n = Number.parseInt(envPort, 10);
    if (Number.isFinite(n)) return n;
  }
  return 7400;
}

export interface DaemonHealth {
  version: string;
  pid: number;
  uptime_ms: number;
  port: number;
  /** Absent on a daemon predating the session index, or one not indexing. */
  index?: HealthIndexState | null;
}

/** GET `/health` on the loopback daemon; null on any failure. */
export async function probeHealth(port: number): Promise<DaemonHealth | null> {
  return (await pkgProbeHealth(port)) as DaemonHealth | null;
}
