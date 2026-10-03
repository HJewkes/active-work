import {
  discoverTranscripts,
  type DiscoveredTranscript,
  type TranscriptRoot,
} from '@titan-design/session-read';
import {
  allTaskIds,
  enrichTasks,
  indexTranscript,
  rollupSessions,
} from '@titan-design/session-graph';
import type { WorkspaceGraph } from './graph.js';
import type { DrainedDirtySet } from './dirty-set.js';
import { transcriptFromPath } from './transcript-path.js';
import { taskResolver } from './tasks.js';
import { refreshEpisodes, snapshotOffsets } from './episodes.js';
import { refreshWorkspace } from '../workspace-index/refresh.js';
import { bytesAdvanced, lapTimer } from './pass-metrics.js';
import type { RefreshSummary } from './refresh.js';

type IndexStatus = 'indexed' | 'unchanged' | 'rewound' | 'missing' | 'quarantined';

/** An unknown root only re-checks rows modified this recently; older ones are settled. */
export const UNKNOWN_ROOT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DeltaPassOptions {
  graph: WorkspaceGraph;
  transcripts: readonly DiscoveredTranscript[];
  yieldPoint: () => Promise<void>;
  taskRoot?: string;
  episodeLimit?: number;
  /** The caller saw the active root change; otherwise the workspace half is skipped. */
  activeRootChanged?: boolean;
  activeRoot?: string;
  skipWorkspace?: boolean;
}

/**
 * The files an unknown root might hide changes in: every file with no row, plus
 * rows modified inside the window. Discovery only lists directories; nothing is
 * statted here, so settled rows cost no I/O.
 */
export async function unknownRootCandidates(
  graph: WorkspaceGraph,
  { root, account }: TranscriptRoot,
  now: number = Date.now(),
): Promise<DiscoveredTranscript[]> {
  const listed = await discoverTranscripts(root);
  return listed
    .map((transcript) => ({ ...transcript, account }))
    .filter((transcript) => {
      const row = graph.transcripts.get(transcript.displayPath);
      if (!row?.fileMtime) return true;
      return now - Date.parse(row.fileMtime) <= UNKNOWN_ROOT_WINDOW_MS;
    });
}

/** Turn a drained dirty set into the transcripts to visit, deduplicated by path. */
export async function transcriptsFromDirty(
  graph: WorkspaceGraph,
  drained: DrainedDirtySet,
  roots: readonly TranscriptRoot[],
  now: number = Date.now(),
): Promise<DiscoveredTranscript[]> {
  const byPath = new Map<string, DiscoveredTranscript>();
  for (const absolute of drained.paths) {
    const transcript = transcriptFromPath(absolute, roots);
    if (transcript) byPath.set(transcript.absolutePath, transcript);
  }
  for (const root of roots.filter(({ root }) => drained.unknownRoots.includes(root))) {
    for (const transcript of await unknownRootCandidates(graph, root, now)) {
      byPath.set(transcript.absolutePath, transcript);
    }
  }
  return [...byPath.values()];
}

const NO_PRESERVED = { restored: 0, merged: 0, skipped: 0 };

/**
 * Index each transcript in turn. A throw mid-scan (a shutdown abort at the
 * yield point) still rolls up the sessions already committed: their offsets
 * have advanced, so no later delta pass would revisit them (TP-791).
 */
async function scanTranscripts(
  graph: WorkspaceGraph,
  transcripts: readonly DiscoveredTranscript[],
  yieldPoint: () => Promise<void>,
): Promise<{ counts: Record<IndexStatus, number>; touched: string[]; facts: number }> {
  const counts = { indexed: 0, unchanged: 0, rewound: 0, missing: 0, quarantined: 0 };
  const touched: string[] = [];
  let facts = 0;
  try {
    for (const transcript of transcripts) {
      const outcome = await indexTranscript(graph, transcript);
      counts[outcome.status] += 1;
      facts += outcome.facts;
      touched.push(...outcome.sessionIds);
      await yieldPoint();
    }
  } catch (err) {
    rollupSessions(graph, touched);
    throw err;
  }
  return { counts, touched, facts };
}

/**
 * Index only `transcripts`, roll up the sessions they touched and enrich new
 * tasks. Skips what a full pass does over the whole corpus: facet backfill,
 * reconcile, PR outcomes, review rounds, missing-row marking, preserved-row
 * replay and the quarantine report.
 */
export async function runDeltaPass(options: DeltaPassOptions): Promise<RefreshSummary> {
  const { graph, transcripts, yieldPoint } = options;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const offsetsBefore = snapshotOffsets(graph);
  const lap = lapTimer();
  const phases: Record<string, number> = {};
  const tasksBefore = new Set(allTaskIds(graph));
  const { counts, touched, facts } = await scanTranscripts(graph, transcripts, yieldPoint);
  phases.scan = lap();
  const turnsRolledUp = rollupSessions(graph, touched);
  const newTasks = allTaskIds(graph).filter((id) => !tasksBefore.has(id));
  const tasks = await enrichTasks(graph, taskResolver(options.taskRoot), newTasks);
  phases.rollup = lap();
  const episodes = await refreshEpisodes(
    graph,
    offsetsBefore,
    options.episodeLimit,
    yieldPoint,
    false,
  );
  phases.episodes = lap();
  const workspace =
    options.activeRootChanged && !options.skipWorkspace
      ? await refreshWorkspace(graph, { activeRoot: options.activeRoot ?? options.taskRoot })
      : null;
  phases.workspace = lap();
  return {
    kind: 'delta',
    startedAt,
    durationMs: Date.now() - started,
    transcripts: transcripts.length,
    scanned: transcripts.length,
    filesOpened: counts.indexed + counts.rewound + counts.quarantined,
    bytesRead: bytesAdvanced(offsetsBefore, snapshotOffsets(graph)),
    phases,
    ...counts,
    reconciledMissing: 0,
    facetsBackfilled: 0,
    facetBacklog: 0,
    ...episodes,
    factsAdded: facts,
    turnsRolledUp,
    tasksRequested: tasks.requested,
    tasksApplied: tasks.applied,
    workspace,
    preserved: NO_PRESERVED,
    errors: tasks.failed ? [`tasks: ${tasks.error ?? 'resolver failed'}`] : [],
  };
}
