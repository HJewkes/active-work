/**
 * PID file lifecycle helpers for the daemon.
 *
 * The PID file lives at `<state>/daemon.pid`; a companion metadata JSON
 * sits at `<state>/daemon.meta.json` and carries the port, version, and
 * started-at timestamp so external callers can introspect the daemon
 * without opening an HTTP connection.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getStateRoot } from '../utils/paths.js';
import type { HealthIndexState } from './health.js';

export interface DaemonMeta {
  port: number;
  version: string;
  started: string;
}

export interface PidFileContents {
  pid: number;
  meta: DaemonMeta;
}

function pidPath(): string {
  return path.join(getStateRoot(), 'daemon.pid');
}

function metaPath(): string {
  return path.join(getStateRoot(), 'daemon.meta.json');
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(getStateRoot(), { recursive: true });
}

/**
 * Write `contents` to `target` so no reader can ever observe it half-written.
 *
 * `fs.writeFile` opens with `O_TRUNC` and writes as a separate syscall, so a
 * concurrent reader between the two sees an empty file, and a concurrent
 * *writer* interleaves byte-for-byte: a departing daemon's `3273` landing on
 * top of a successor's `999999` yields the literal `327399` (AW-88). Staging
 * in a sibling temp file and `rename`-ing it into place makes the swap atomic
 * — a reader sees either the whole old file or the whole new one.
 */
let tmpCounter = 0;

async function writeFileAtomic(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${(tmpCounter++).toString(36)}.tmp`;
  try {
    await fs.writeFile(tmp, contents, 'utf8');
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function writePidFile(pid: number, meta: DaemonMeta): Promise<void> {
  await ensureStateDir();
  // Meta first: the PID file is the discovery handle, so anything that finds
  // it must also find the metadata rather than the `port: 0` fallback.
  await writeFileAtomic(metaPath(), JSON.stringify(meta, null, 2));
  await writeFileAtomic(pidPath(), String(pid));
}

export async function readPidFile(): Promise<PidFileContents | null> {
  let pidRaw: string;
  try {
    pidRaw = await fs.readFile(pidPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const pid = Number.parseInt(pidRaw.trim(), 10);
  if (!Number.isFinite(pid)) return null;

  let metaRaw: string | undefined;
  try {
    metaRaw = await fs.readFile(metaPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const meta: DaemonMeta = metaRaw
    ? (JSON.parse(metaRaw) as DaemonMeta)
    : { port: 0, version: 'unknown', started: '' };
  return { pid, meta };
}

/**
 * Delete the PID file — but only while it still names `expectedPid`.
 *
 * launchd restarts overlap by design: the successor binds the port and
 * writes its own PID file before the departing instance's SIGTERM handler
 * gets to clean up. An unconditional unlink there deletes the *successor's*
 * file, leaving a live daemon that `mcp status`, `doctor`, `mcp stop` and
 * `mcp restart` all report as absent, recoverable only via launchctl
 * (AW-76). Every caller therefore names the pid whose file it means to
 * clear; a mismatch means someone else owns the daemon now, so we leave it.
 *
 * Returns whether the file was removed.
 */
export async function removePidFile(expectedPid: number): Promise<boolean> {
  const current = await readPidFile();
  if (current === null) return false;
  if (current.pid !== expectedPid) return false;
  for (const p of [pidPath(), metaPath()]) {
    try {
      await fs.unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return true;
}

export const DEFAULT_DAEMON_PORT = 7400;

/**
 * The port a daemon would be listening on absent an explicit `--port`.
 *
 * Callers that have lost the PID file (see `removePidFile`) still need
 * somewhere to aim a health probe; the installed launchd/systemd unit runs
 * `mcp serve` with no port argument, so this is the port in practice.
 */
export function resolveDaemonPort(): number {
  const envPort = process.env.AW_PORT;
  if (envPort) {
    const n = Number.parseInt(envPort, 10);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_DAEMON_PORT;
}

export interface DaemonHealth {
  version: string;
  pid: number;
  uptime_ms: number;
  port: number;
  /** Absent on a daemon predating the session index, or one not indexing. */
  index?: HealthIndexState | null;
}

const HEALTH_TIMEOUT_MS = 500;

/** GET `/health` on the loopback daemon; null on any failure. */
export async function probeHealth(port: number): Promise<DaemonHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as DaemonHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it.
    if (code === 'EPERM') return true;
    return false;
  }
}
