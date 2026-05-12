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

export async function writePidFile(pid: number, meta: DaemonMeta): Promise<void> {
  await ensureStateDir();
  await fs.writeFile(pidPath(), String(pid), 'utf8');
  await fs.writeFile(metaPath(), JSON.stringify(meta, null, 2), 'utf8');
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

export async function removePidFile(): Promise<void> {
  for (const p of [pidPath(), metaPath()]) {
    try {
      await fs.unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
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
