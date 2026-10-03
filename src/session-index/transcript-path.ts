import os from 'node:os';
import path from 'node:path';
import type { DiscoveredTranscript, TranscriptRoot } from '@titan-design/session-read';

const SUBAGENT_DIR = 'subagents';
const SUBAGENT_PREFIX = 'agent-';

function toDisplayPath(absolutePath: string, home: string): string {
  return absolutePath.startsWith(`${home}/`) ? `~${absolutePath.slice(home.length)}` : absolutePath;
}

function subagentIdFrom(file: string): string | null {
  if (!file.startsWith(SUBAGENT_PREFIX) || !file.endsWith('.jsonl')) return null;
  const id = file.slice(SUBAGENT_PREFIX.length, -'.jsonl'.length);
  return id.length > 0 ? id : null;
}

/**
 * Rebuild the record `discoverTranscripts` would have produced for one file,
 * without walking the tree. Returns null for a path discovery would not list:
 * outside every root, not `.jsonl`, or deeper than `<project>/<session>/subagents`.
 */
export function transcriptFromPath(
  absolutePath: string,
  roots: readonly TranscriptRoot[],
  home: string = os.homedir(),
): DiscoveredTranscript | null {
  for (const { root, account } of roots) {
    const rel = path.relative(root, absolutePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split(path.sep);
    const [projectDir, ...rest] = parts;
    const file = parts[parts.length - 1] ?? '';
    if (!projectDir || !file.endsWith('.jsonl')) return null;
    const direct = rest.length === 1;
    const sidechain = rest.length === 3 && rest[1] === SUBAGENT_DIR;
    const subagentId = sidechain ? subagentIdFrom(file) : null;
    if (!direct && !(sidechain && subagentId)) return null;
    return {
      projectDir,
      absolutePath,
      displayPath: toDisplayPath(absolutePath, home),
      subagentId,
      account,
    };
  }
  return null;
}
