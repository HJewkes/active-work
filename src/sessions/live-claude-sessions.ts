import { promises as fs } from 'node:fs';
import path from 'node:path';
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

function parsePidFile(raw: string): PidFile | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const { pid, sessionId } = data;
    if (typeof pid !== 'number' || typeof sessionId !== 'string') return null;
    return { pid, sessionId };
  } catch {
    return null;
  }
}

async function readPidFiles(configDir: string): Promise<PidFile[]> {
  const dir = path.join(configDir, 'sessions');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files: PidFile[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const parsed = parsePidFile(await fs.readFile(path.join(dir, name), 'utf8').catch(() => ''));
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
