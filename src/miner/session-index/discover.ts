import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DiscoveredTranscript {
  /** The project directory name Claude Code derives from the session's cwd. */
  projectDir: string;
  absolutePath: string;
  /** `~`-relative form; what gets stored in `transcripts.path`. */
  displayPath: string;
}

/** Root of Claude Code's per-project transcript store. */
export function transcriptsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function toDisplayPath(absolutePath: string): string {
  const home = os.homedir();
  return absolutePath.startsWith(`${home}/`) ? `~${absolutePath.slice(home.length)}` : absolutePath;
}

/**
 * List every `~/.claude/projects/<project>/<session>.jsonl`, sorted so a full
 * corpus rebuild visits transcripts in a stable order. A project directory
 * that disappears mid-walk is skipped rather than aborting the scan.
 */
export async function discoverTranscripts(
  root: string = transcriptsRoot(),
): Promise<DiscoveredTranscript[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch {
    return [];
  }

  const found: DiscoveredTranscript[] = [];
  for (const projectDir of projectDirs.sort()) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(root, projectDir));
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.jsonl')) continue;
      const absolutePath = path.join(root, projectDir, entry);
      found.push({ projectDir, absolutePath, displayPath: toDisplayPath(absolutePath) });
    }
  }
  return found;
}
