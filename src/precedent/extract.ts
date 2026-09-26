import path from 'node:path';
import { resolveSlugFromCwd } from '../commands/_open-helpers.js';
import { agentChatHome } from '../session-index/origin-agent-chat.js';
import { defaultGraphPath, openGraphReadOnly } from '../session-index/graph.js';
import { extractNoteRows } from './notes.js';
import { extractQueueRows } from './queue.js';
import type { PrecedentRow } from './schema.js';
import { appendPrecedents, precedentFileFor, readAllPrecedents } from './store.js';
import {
  extractTranscriptRows,
  listAskCalls,
  transcriptKey,
  type AskCall,
  type InitiativeResolver,
} from './transcripts.js';

export interface ExtractOptions {
  activeRoot: string;
  graphPath?: string;
  eventsDbPath?: string;
}

export interface ExtractSummary {
  askCalls: number;
  alreadyIndexed: number;
  pending: number;
  written: { transcript: number; note: number; queue: number };
  files: string[];
  errors: string[];
}

function cachedResolver(activeRoot: string): InitiativeResolver {
  const cache = new Map<string, string | null>();
  return async (cwd) => {
    if (cwd === null) return null;
    if (!cache.has(cwd)) cache.set(cwd, (await resolveSlugFromCwd(activeRoot, cwd))?.slug ?? null);
    return cache.get(cwd) ?? null;
  };
}

function readAskCalls(graphPath: string): AskCall[] {
  const graph = openGraphReadOnly(graphPath);
  try {
    return listAskCalls(graph);
  } finally {
    graph.close();
  }
}

function groupByFile(activeRoot: string, rows: PrecedentRow[]): Map<string, PrecedentRow[]> {
  const groups = new Map<string, PrecedentRow[]>();
  for (const row of rows) {
    const file = precedentFileFor(activeRoot, row.initiative);
    groups.set(file, [...(groups.get(file) ?? []), row]);
  }
  return groups;
}

function countBySource(rows: PrecedentRow[]): ExtractSummary['written'] {
  const count = { transcript: 0, note: 0, queue: 0 };
  for (const row of rows) count[row.source] += 1;
  return count;
}

export async function extractPrecedents(options: ExtractOptions): Promise<ExtractSummary> {
  const { activeRoot } = options;
  const seen = new Set((await readAllPrecedents(activeRoot)).rows.map((row) => row.key));

  const calls = readAskCalls(options.graphPath ?? defaultGraphPath());
  const unseen = calls.filter((c) => !seen.has(transcriptKey(c.sessionId, c.toolUseId)));
  const transcripts = await extractTranscriptRows(unseen, cachedResolver(activeRoot));

  const eventsDb = options.eventsDbPath ?? path.join(agentChatHome(), 'events.db');
  const others = [...(await extractNoteRows(activeRoot)), ...extractQueueRows(eventsDb)];
  const fresh = [...transcripts.rows, ...others.filter((row) => !seen.has(row.key))];

  const groups = groupByFile(activeRoot, fresh);
  for (const [file, rows] of groups) await appendPrecedents(file, rows);

  return {
    askCalls: calls.length,
    alreadyIndexed: calls.length - unseen.length,
    pending: transcripts.pending,
    written: countBySource(fresh),
    files: [...groups.keys()].sort(),
    errors: transcripts.errors,
  };
}
