import path from 'node:path';
import {
  extractSource,
  noteSource,
  transcriptSource,
  type ExtractSummary,
  type InitiativeResolver,
  type TranscriptFile,
} from '@titan-design/decider';
import { toAbsolutePath } from '@titan-design/session-read';
import { resolveSlugFromCwd } from '../commands/_open-helpers.js';
import { agentChatHome } from '../session-index/origin-agent-chat.js';
import { defaultGraphPath, openGraphReadOnly } from '../session-index/graph.js';
import { exclusionPolicy, loadHumanOnlyInitiatives } from './human-only.js';
import { ledgerPath, openLedger, v1PrecedentSource } from './ledger.js';
import { queueSource } from './queue-source.js';

export interface ExtractOptions {
  activeRoot: string;
  graphPath?: string;
  eventsDbPath?: string;
}

export interface ExtractResult {
  ledger: string;
  sources: ExtractSummary[];
}

function cachedResolver(activeRoot: string): InitiativeResolver {
  const cache = new Map<string, string | null>();
  return async (cwd) => {
    if (cwd === null) return null;
    if (!cache.has(cwd)) cache.set(cwd, (await resolveSlugFromCwd(activeRoot, cwd))?.slug ?? null);
    return cache.get(cwd) ?? null;
  };
}

/** Only transcripts the miner graph saw an `AskUserQuestion` in, so a pass never reads them all. */
function askTranscripts(graphPath: string): () => Promise<TranscriptFile[]> {
  return () => {
    const graph = openGraphReadOnly(graphPath);
    try {
      const found = graph
        .prepare(
          `SELECT DISTINCT t.source_key AS sourceKey
             FROM tool_call c
             JOIN transcript t ON t.source_id = c.transcript_id
            WHERE c.name = 'AskUserQuestion'
            ORDER BY t.source_key`,
        )
        .all() as { sourceKey: string }[];
      const files = found.map((f) => ({ path: toAbsolutePath(f.sourceKey), namespace: 'default' }));
      return Promise.resolve(files);
    } finally {
      graph.close();
    }
  };
}

/**
 * Index the human's answers into the decider ledger. The charter is read first
 * and an unreadable one stops the run before anything is written.
 */
export async function extractPrecedents(options: ExtractOptions): Promise<ExtractResult> {
  const { activeRoot } = options;
  const policy = exclusionPolicy(await loadHumanOnlyInitiatives(activeRoot));
  const sources = [
    v1PrecedentSource(activeRoot),
    transcriptSource({
      transcripts: askTranscripts(options.graphPath ?? defaultGraphPath()),
      resolveInitiative: cachedResolver(activeRoot),
    }),
    noteSource({ root: activeRoot }),
    queueSource(options.eventsDbPath ?? path.join(agentChatHome(), 'events.db')),
  ];
  const store = openLedger(activeRoot);
  try {
    const summaries: ExtractSummary[] = [];
    for (const source of sources) summaries.push(await extractSource(store, source, policy));
    return { ledger: ledgerPath(activeRoot), sources: summaries };
  } finally {
    store.db.close();
  }
}
