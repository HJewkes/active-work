import path from 'node:path';
import { promises as fs } from 'node:fs';
import lockfile from 'proper-lockfile';
import { discoverTranscripts, transcriptsRoot } from '@titan-design/session-read';
import { refreshCorpus, resetIndex } from '@titan-design/session-graph';
import { defaultGraphPath, openGraph, type WorkspaceGraph } from './graph.js';
import { taskResolver } from './tasks.js';
import { refreshWorkspace, type WorkspaceRefreshSummary } from '../workspace-index/refresh.js';
import { resetWorkspaceIndex } from '../workspace-index/write.js';

/**
 * One refresh pass over the transcript corpus: discover -> index each changed
 * transcript -> roll up -> reconcile -> enrich tasks from the active-work store.
 *
 * The pass itself is `@titan-design/session-graph`; what lives here is what the
 * package must not know — where the corpus is, where the graph file is, the
 * cross-process lock, and which store resolves a `task:` ref. This is the
 * single code path behind `tools/build-session-index.mjs`, the `miner refresh`
 * command and the daemon's watcher, so a bug can only be fixed (or introduced)
 * once.
 */

export interface RefreshOptions {
  /** Reuse an open graph (the daemon holds one); otherwise one is opened. */
  graph?: WorkspaceGraph;
  dbPath?: string;
  /** Wipe every derived row and re-read every transcript from byte 0. */
  full?: boolean;
  /** Visit at most this many transcripts (debugging aid). */
  limit?: number;
  /** Stream a whole-file sha256 per transcript; defaults to `full`. */
  verifyHashes?: boolean;
  /** Transcript corpus root; overridable for tests. */
  root?: string;
  /** Active-work root the task resolver reads; defaults to `getActiveRoot()`. */
  taskRoot?: string;
  /**
   * Active root the workspace pass indexes; defaults to `taskRoot`, then to
   * `getActiveRoot()`. Both halves of this database read the same root, so a
   * test that redirects one must redirect the other.
   */
  activeRoot?: string;
  /** Skip the workspace half of the pass. For tests that only care about transcripts. */
  skipWorkspace?: boolean;
}

export interface RefreshSummary {
  startedAt: string;
  durationMs: number;
  /** Transcripts discovered in the corpus. */
  transcripts: number;
  /** Transcripts this pass actually visited (differs under `--limit`). */
  scanned: number;
  indexed: number;
  /** Transcripts re-read from byte 0 because the source was rewritten. */
  rewound: number;
  unchanged: number;
  quarantined: number;
  /** Visited transcripts that vanished mid-pass, between discovery and stat. */
  missing: number;
  /** Rows marked `missing` because their file was already gone (AW-105). */
  reconciledMissing: number;
  factsAdded: number;
  turnsRolledUp: number;
  /** Task ids handed to the resolver, and rows it wrote. */
  tasksRequested: number;
  tasksApplied: number;
  /** The workspace half of the pass (TP-24); null when skipped. */
  workspace: WorkspaceRefreshSummary | null;
  errors: string[];
}

export const LOCK_STALE_MS = 60_000;

/** `<minerRoot>/graph.sqlite3.lock` — the cross-process refresh mutex. */
export function refreshLockPath(): string {
  return `${defaultGraphPath()}.lock`;
}

/**
 * Run `fn` holding the refresh lock, *blocking* until the current holder
 * releases rather than failing fast: a user typing `miner refresh` while the
 * daemon happens to be mid-pass wants their refresh to happen, not an error.
 * A crashed holder's lock goes stale after `LOCK_STALE_MS`.
 */
export async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const target = refreshLockPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '', { flag: 'a' });
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: { retries: 120, factor: 1.5, minTimeout: 200, maxTimeout: 2_000 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * `verifyHashes` defaults to `full` on purpose, and drives both of the
 * package's hash options: `verifyHash` re-reads each transcript's consumed
 * prefix (detecting a rewrite that left the file the same length or longer),
 * `withContentHash` stores a whole-file sha256 for durability reporting. Both
 * are O(corpus), and making incremental passes sample them would make two runs
 * over identical inputs produce different `content_hash` state — which the
 * equivalence eval reads as a real divergence. Drift detection rides on
 * `--full`.
 *
 * The cost of that default: an ordinary incremental pass cannot see a rotation
 * that grew the file, so such a transcript reads from a stale offset, lands
 * mid-line and quarantines until the next `--full`. The pre-package extractor
 * hashed the prefix on every resume; `resumePoint` hashes *before* it decides
 * there is nothing to do, so making that unconditional would re-read the whole
 * corpus on every 60-second daemon poll.
 */
export async function runRefresh(options: RefreshOptions = {}): Promise<RefreshSummary> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const graph = options.graph ?? openGraph(options.dbPath ?? defaultGraphPath());
  const owned = options.graph === undefined;

  try {
    if (options.full) {
      // Both halves, because they share the edge and FTS tables: resetting one
      // alone would leave the other's rows behind their own spans and edges.
      resetIndex(graph);
      resetWorkspaceIndex(graph);
    }
    const discovered = await discoverTranscripts(options.root ?? transcriptsRoot());
    const visiting = discovered.slice(0, options.limit ?? discovered.length);
    const verify = options.verifyHashes ?? options.full ?? false;

    const summary = await refreshCorpus(graph, visiting, {
      full: options.full,
      verifyHash: verify,
      withContentHash: verify,
      resolveTasks: taskResolver(options.taskRoot),
    });

    // After the transcripts, so `mentions` and the task join see the rows the
    // transcript pass just wrote.
    const workspace = options.skipWorkspace
      ? null
      : await refreshWorkspace(graph, {
          activeRoot: options.activeRoot ?? options.taskRoot,
          full: options.full,
        });

    return {
      startedAt,
      durationMs: Date.now() - started,
      transcripts: discovered.length,
      scanned: visiting.length,
      indexed: summary.indexed,
      rewound: summary.rewound,
      unchanged: summary.unchanged,
      quarantined: summary.quarantined,
      missing: summary.missing,
      reconciledMissing: summary.markedMissing,
      factsAdded: summary.facts,
      turnsRolledUp: summary.turnsRolledUp,
      tasksRequested: summary.tasks.requested,
      tasksApplied: summary.tasks.applied,
      workspace,
      errors: [
        ...(summary.tasks.failed ? [`tasks: ${summary.tasks.error ?? 'resolver failed'}`] : []),
        ...quarantineErrors(graph),
        ...(workspace?.malformed ?? []).map(
          (entry) => `workspace: ${entry.path} — ${entry.reason}`,
        ),
      ],
    };
  } finally {
    if (owned) graph.db.close();
  }
}

/**
 * Read the quarantine reasons back off the transcript rows rather than out of
 * the pass, because the package reports counts and stores the reasons. That
 * makes this the standing set of unreadable transcripts, not just the ones this
 * pass tripped over — which is the more useful answer for a command whose job
 * is "is the index healthy". Rows marked `missing` are excluded: a rotated
 * transcript is ordinary, and `reconciledMissing` already counts them.
 */
function quarantineErrors(graph: WorkspaceGraph): string[] {
  return graph.transcripts
    .list()
    .filter((row) => row.status === 'quarantined')
    .map((row) => `quarantined: ${row.sourceKey} — ${row.statusReason ?? 'no reason recorded'}`);
}
