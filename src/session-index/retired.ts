import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DiscoveredTranscript } from '@titan-design/session-read';
import type { SessionGraph } from '@titan-design/session-graph';
import type { WatermarkRow } from '@titan-design/store-sqlite';

import {
  agentChatHome,
  eventsDbSource,
  type LifecycleEvent,
  type OpenDatabase,
  type SpawnSource,
} from './origin-agent-chat.js';

/**
 * Retired agents stop writing, so once the index has read a retired session's
 * transcript to the end, the full pass has nothing left to learn from it
 * (TP-789). Skipping those saves a stat and a resume check per file per pass.
 */

export const SEAL_GRACE_MS = 10 * 60_000;

/** Skipping is only a saving, so a locked `events.db` is not worth better-sqlite3's 5 s busy wait. */
const EVENTS_BUSY_TIMEOUT_MS = 100;

const openBriefly: OpenDatabase = (file, options) =>
  new Database(file, { ...options, timeout: EVENTS_BUSY_TIMEOUT_MS });

/**
 * Session id to retire time in epoch ms, from agent-chat's `events.db`. Any
 * later event naming the session (a resume, or a respawn reusing it) revives
 * it. An unreadable record yields an empty map, so every transcript stays indexed.
 */
export function retiredSessions(
  source: SpawnSource = eventsDbSource(agentChatHome(), openBriefly),
): Map<string, number> {
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
    else retired.delete(sessionId);
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
 * left: a retired agent stops writing. One stat rules out a late write (a flush
 * after the retire, or a `claude --resume` that logs no event), so a file longer
 * than the row is never sealed (TP-874). A read from before the retire also
 * needs an unchanged mtime, and is then re-stamped.
 */
async function isSealed(
  graph: Pick<SessionGraph, 'transcripts'>,
  row: WatermarkRow,
  retiredAt: number,
  absolutePath: string,
): Promise<boolean> {
  if (row.status !== 'ok' || row.lastOffset !== row.fileSize) return false;
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat || stat.size !== row.fileSize) return false;
  if (row.lastIndexedAt !== null && Date.parse(row.lastIndexedAt) >= retiredAt) return true;
  if (stat.mtime.toISOString() !== row.fileMtime) return false;
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
 * stays in, and so does a transcript whose path the watcher reported since the
 * last pass (`dirtyPaths`), so it is indexed once more before it seals.
 */
export async function sealedFilter(
  graph: Pick<SessionGraph, 'transcripts'>,
  discovered: DiscoveredTranscript[],
  retired: Map<string, number>,
  graceMs: number = SEAL_GRACE_MS,
  dirtyPaths: ReadonlySet<string> = new Set(),
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
      !dirtyPaths.has(transcript.absolutePath) &&
      now - retiredAt > graceMs &&
      row !== undefined &&
      (await isSealed(graph, row, retiredAt, transcript.absolutePath));
    if (!sealed) kept.push(transcript);
  }
  return kept;
}

/**
 * Discovered transcripts this pass left out of the corpus walk that the graph held as `ok`.
 * `markMissing` stats an absent row by its `~/` display path, which never resolves,
 * so it flags these `missing` while their files exist (TP-878).
 */
export function unvisitedOk(
  graph: Pick<SessionGraph, 'transcripts'>,
  discovered: DiscoveredTranscript[],
  visiting: DiscoveredTranscript[],
): string[] {
  const visited = new Set(visiting.map((transcript) => transcript.displayPath));
  const ok = new Set(
    graph.transcripts
      .list()
      .filter((row) => row.status === 'ok')
      .map((row) => row.sourceKey),
  );
  return discovered
    .map((transcript) => transcript.displayPath)
    .filter((key) => !visited.has(key) && ok.has(key));
}

/** Undo the `missing` mark `markMissing` put on rows whose files were never checked. */
export function restoreUnvisited(graph: Pick<SessionGraph, 'transcripts'>, keys: string[]): number {
  const missing = new Set(
    graph.transcripts
      .list()
      .filter((row) => row.status === 'missing')
      .map((row) => row.sourceKey),
  );
  const restored = keys.filter((key) => missing.has(key));
  for (const key of restored) graph.transcripts.markStatus(key, 'ok', null);
  return restored.length;
}
