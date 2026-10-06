import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../errors.js';
import { getProcessCommand, isProcessAlive } from '../server/lifecycle.js';

/**
 * Which Claude session ids a running `claude` process holds right now.
 *
 * Claude Code keeps `<configDir>/sessions/<pid>.json` naming the session each
 * process is on, and leaves the file behind when the process dies hard — the
 * reboot or crash that leaves a session unwrapped. So a file alone proves
 * nothing: its pid must be alive, and (pids are recycled across a reboot)
 * still look like Claude.
 */
export type LiveSessionIds = () => Promise<Set<string>>;

export interface ProcessProbes {
  isAlive: (pid: number) => boolean;
  getComm: (pid: number) => string | null;
}

const DEFAULT_PROBES: ProcessProbes = { isAlive: isProcessAlive, getComm: getProcessCommand };

/** Claude runs as its own binary or under node; anything else is a recycled pid. */
const CLAUDE_COMM = /claude|node/i;

interface PidFile {
  pid: number;
  sessionId: string;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function unreadable(file: string, why: string): ValidationError {
  return new ValidationError(
    `Cannot tell whether a claude process holds a session: ${file} ${why}. ` +
      'Nothing was recovered; fix or remove the file and run again.',
  );
}

function parsePidFile(file: string, raw: string): PidFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw unreadable(file, 'is not valid JSON');
  }
  const { pid, sessionId } = (data ?? {}) as Record<string, unknown>;
  if (typeof pid !== 'number' || typeof sessionId !== 'string') {
    throw unreadable(file, 'has no numeric pid and string sessionId');
  }
  return { pid, sessionId };
}

/** A file gone between readdir and read is a process that just exited: dead, not unknown. */
async function readPidFile(file: string): Promise<PidFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw unreadable(file, `could not be read (${(err as Error).message})`);
  }
  return parsePidFile(file, raw);
}

/**
 * Fails closed: a pid file or directory that cannot be read aborts the run,
 * since treating it as dead could recover a session that is still running.
 */
async function readPidFiles(configDir: string): Promise<PidFile[]> {
  const dir = path.join(configDir, 'sessions');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw unreadable(dir, `could not be listed (${(err as Error).message})`);
  }
  const files: PidFile[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const parsed = await readPidFile(path.join(dir, name));
    if (parsed) files.push(parsed);
  }
  return files;
}

/** An unreadable command name counts as Claude: wrongly refusing beats recovering a live session. */
function isClaudeProcess(pid: number, probes: ProcessProbes): boolean {
  if (!probes.isAlive(pid)) return false;
  const comm = probes.getComm(pid);
  return comm === null || CLAUDE_COMM.test(path.basename(comm));
}

export function liveSessionIdsFrom(
  configDirs: string[],
  probes: ProcessProbes = DEFAULT_PROBES,
): LiveSessionIds {
  return async () => {
    const live = new Set<string>();
    for (const configDir of configDirs) {
      for (const { pid, sessionId } of await readPidFiles(configDir)) {
        if (isClaudeProcess(pid, probes)) live.add(sessionId);
      }
    }
    return live;
  };
}
