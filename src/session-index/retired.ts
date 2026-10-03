import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DiscoveredTranscript } from '@titan-design/session-read';
import type { SessionGraph } from '@titan-design/session-graph';
import type { WatermarkRow } from '@titan-design/store-sqlite';

import { eventsDbSource, type LifecycleEvent, type SpawnSource } from './origin-agent-chat.js';

/**
 * Retired agents stop writing, so once the index has read a retired session's
 * transcript to the end, the full pass has nothing left to learn from it
 * (TP-789). Skipping those saves a stat and a resume check per file per pass.
 */

export const SEAL_GRACE_MS = 10 * 60_000;

/** An agent picked up again after its retire is writing to the session once more. */
const REVIVING_KINDS = new Set(['agent_resumed', 'agent_attached']);

/**
 * Session id to retire time in epoch ms, from agent-chat's `events.db`. An
 * unreadable record yields an empty map, so every transcript stays indexed.
 */
export function retiredSessions(source: SpawnSource = eventsDbSource()): Map<string, number> {
  let events: LifecycleEvent[];
  try {
    events = source.events();
  } catch {
    return new Map();
  }
  const retired = new Map<string, number>();
  for (const event of events) {
    const sessionId = event.meta.session_id;
    if (typeof sessionId !== 'string' || sessionId === '') continue;
    if (event.kind === 'agent_retired') retired.set(sessionId, event.ts);
    else if (REVIVING_KINDS.has(event.kind)) retired.delete(sessionId);
  }
  return retired;
}

/** `<session>.jsonl`, or `<session>/subagents/agent-<id>.jsonl` for a subagent sidechain. */
function sessionOf(transcript: DiscoveredTranscript): string {
  const file = transcript.absolutePath;
  return transcript.subagentId
    ? path.basename(path.dirname(path.dirname(file)))
    : path.basename(file, '.jsonl');
}

/**
 * The index read this row to its end after the agent retired, so nothing is
 * left: a retired agent stops writing. An earlier read needs one stat to rule
 * out a tail written before the retire; when the file is unchanged the row is
 * re-stamped, so later passes skip it with no stat.
 */
async function isSealed(
  graph: Pick<SessionGraph, 'transcripts'>,
  row: WatermarkRow,
  retiredAt: number,
  absolutePath: string,
): Promise<boolean> {
  if (row.status !== 'ok' || row.lastOffset !== row.fileSize) return false;
  if (row.lastIndexedAt !== null && Date.parse(row.lastIndexedAt) >= retiredAt) return true;
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat || stat.size !== row.fileSize || stat.mtime.toISOString() !== row.fileMtime) return false;
  graph.transcripts.advance(row.sourceKey, {
    lastOffset: row.lastOffset,
    prefixHash: row.prefixHash,
    fileSize: row.fileSize,
    fileMtime: row.fileMtime,
  });
  return true;
}

/**
 * `discovered` without the transcripts of sessions retired more than `graceMs`
 * ago that the index has fully read. A retired transcript with unread bytes
 * stays in, so it is indexed once more before it seals.
 */
export async function sealedFilter(
  graph: Pick<SessionGraph, 'transcripts'>,
  discovered: DiscoveredTranscript[],
  retired: Map<string, number>,
  graceMs: number = SEAL_GRACE_MS,
): Promise<DiscoveredTranscript[]> {
  if (retired.size === 0) return discovered;
  const now = Date.now();
  const rows = new Map(graph.transcripts.list().map((row) => [row.sourceKey, row]));
  const kept: DiscoveredTranscript[] = [];
  for (const transcript of discovered) {
    const retiredAt = retired.get(sessionOf(transcript));
    const row = rows.get(transcript.displayPath);
    const sealed =
      retiredAt !== undefined &&
      now - retiredAt > graceMs &&
      row !== undefined &&
      (await isSealed(graph, row, retiredAt, transcript.absolutePath));
    if (!sealed) kept.push(transcript);
  }
  return kept;
}

