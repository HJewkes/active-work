import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import lockfile from 'proper-lockfile';
import { discoverAllTranscripts, discoverTranscripts } from '@titan-design/session-read';
import { refreshCorpus, resetIndex, syncPrices } from '@titan-design/session-graph';
import { PRICE_TABLE, PRICE_TABLE_VERSION } from '@titan-design/session-analytics';
import { defaultGraphPath, openGraph, type WorkspaceGraph } from './graph.js';
import { taskResolver } from './tasks.js';
import { ghPrResolver } from './pr-outcomes.js';
import { agentChatOriginResolver } from './origin-agent-chat.js';
import type { RunCommand } from '../discover/run-command.js';
import { refreshWorkspace, type WorkspaceRefreshSummary } from '../workspace-index/refresh.js';
import { resetWorkspaceIndex } from '../workspace-index/write.js';
import { preserveUnreachable, replayPreserved, type ReplaySummary } from './preserve.js';
import { refreshEpisodes, snapshotOffsets } from './episodes.js';
import { runDeltaPass } from './delta-pass.js';
import { bytesAdvanced, lapTimer } from './pass-metrics.js';
import type { DiscoveredTranscript } from '@titan-design/session-read';
import { atomicWrite } from '../utils/fs-atomic.js';
import { isLockContention } from './scheduler.js';

/**
 * One refresh pass over the transcript corpus: discover -> index each changed
 * transcript -> roll up -> reconcile -> enrich tasks from the active-work store
 * and PR outcomes from `gh`.
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
  /**
   * One transcript root instead of every Claude config dir; for tests. Its
   * transcripts carry no account.
   */
  root?: string;
  /**
   * The transcripts to visit, bypassing discovery. A `delta` pass visits only
   * these; a full pass takes them in place of the walk.
   */
  transcripts?: DiscoveredTranscript[];
  /**
   * `delta` indexes just `transcripts` and skips the whole-corpus phases; the
   * default `full` walks everything.
   */
  mode?: 'full' | 'delta';
  /** Delta only: the active root changed, so the workspace half runs. */
  activeRootChanged?: boolean;
  /** Stale audit facets re-extracted this pass; `Infinity` clears the backlog. */
  facetLimit?: number;
  /** Backlogged sessions segmented into episodes this pass; `Infinity` clears the backlog. */
  episodeLimit?: number;
  /**
   * Check every session for a stale episode, not only those this pass touched.
   * Defaults to true; the daemon sweeps only now and then (TP-343).
   */
  episodeSweep?: boolean;
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
  /** Skip PR outcomes from `gh`. For tests that must not reach the network. */
  skipPrOutcomes?: boolean;
  /** Runs `gh` for PR outcomes; tests replace it so the real binary never runs. */
  runGh?: RunCommand;
  /**
   * Awaited between the pass's synchronous chunks, so a daemon caller can hand
   * the event loop to readers. Defaults to one `setImmediate` turn.
   */
  yieldPoint?: () => Promise<void>;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface RefreshSummary {
  /** `delta` when the pass visited only the transcripts it was handed. */
  kind: 'full' | 'delta';
  startedAt: string;
  durationMs: number;
  /** Transcripts discovered in the corpus. */
  transcripts: number;
  /** Transcripts this pass actually visited (differs under `--limit`). */
  scanned: number;
  /** Transcripts the pass read bytes from: indexed, rewound or quarantined. */
  filesOpened: number;
  /** Bytes the watermarks advanced this pass, counting a rewound file from byte 0. */
  bytesRead: number;
  /** Milliseconds spent in each phase; a full pass names discover, corpus, episodes, workspace and preserve, a delta pass scan, rollup, episodes and workspace. */
  phases: Record<string, number>;
  indexed: number;
  /** Transcripts re-read from byte 0 because the source was rewritten. */
  rewound: number;
  unchanged: number;
  quarantined: number;
  /** Visited transcripts that vanished mid-pass, between discovery and stat. */
  missing: number;
  /** Rows marked `missing` because their file was already gone (AW-105). */
  reconciledMissing: number;
  /** Indexed transcripts whose audit facet this pass re-extracted. */
  facetsBackfilled: number;
  /** Transcripts whose audit facet is still stale after this pass. */
  facetBacklog: number;
  /** Sessions whose episodes this pass rewrote (TP-342). */
  episodesWritten: number;
  /** Sessions whose episodes are still stale after this pass; null when it did not sweep. */
  episodeBacklog: number | null;
  factsAdded: number;
  turnsRolledUp: number;
  /** Task ids handed to the resolver, and rows it wrote. */
  tasksRequested: number;
  tasksApplied: number;
  /** The workspace half of the pass (TP-24); null when skipped. */
  workspace: WorkspaceRefreshSummary | null;
  /** Non-derivable rows put back after the pass (TP-41). */
  preserved: ReplaySummary;
  errors: string[];
}

export const LOCK_STALE_MS = 60_000;

/** `<minerRoot>/graph.sqlite3.lock` — the cross-process refresh mutex. */
export function refreshLockPath(): string {
  return `${defaultGraphPath()}.lock`;
}

/** Written beside the lock while it is held, so a blocked caller can name who holds it (TP-791). */
export interface RefreshLockHolder {
  pid: number;
  command: string;
  startedAt: string;
  /** Set when the holder file outlived its writer: `pid` is gone, or it was written before the last boot. */
  stale?: boolean;
}

export interface RefreshLockOptions {
  /** Attempts after the first; `0` fails at once with ELOCKED. Omitted, the call blocks about 4 minutes. */
  retries?: number;
  /** Called once with the current holder when the first attempt finds the lock held and the call will wait. */
  onWait?: (holder: RefreshLockHolder | null) => void;
  /** Ends the wait for the lock; the call then rejects with the abort reason, holding nothing. */
  signal?: AbortSignal;
}

/** proper-lockfile's ELOCKED, carrying the holder file's contents when there was one. */
export type RefreshLockError = Error & { code: 'ELOCKED'; holder: RefreshLockHolder | null };

/** 120 retries backing off from 200 ms by 1.5x to 2 s: about 4 minutes in all. */
const BLOCKING_RETRIES = 120;

function retryDelayMs(attempt: number): number {
  return Math.min(200 * 1.5 ** attempt, 2_000);
}

export function refreshLockHolderPath(): string {
  return `${refreshLockPath()}.holder.json`;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** On darwin libuv reads `os.uptime()` from `kern.boottime`. */
function bootedAtMs(): number {
  return Date.now() - os.uptime() * 1_000;
}

/** A pid alive now may be a different process if the file predates the last boot. */
export async function readRefreshLockHolder(
  bootedAt: number = bootedAtMs(),
): Promise<RefreshLockHolder | null> {
  try {
    const raw = await fs.readFile(refreshLockHolderPath(), 'utf8');
    const holder = JSON.parse(raw) as RefreshLockHolder;
    const live = isRunning(holder.pid) && Date.parse(holder.startedAt) >= bootedAt;
    return live ? holder : { ...holder, stale: true };
  } catch {
    return null;
  }
}

/**
 * Our own retry loop over single attempts, rather than proper-lockfile's, so
 * the wait between attempts can be aborted and the holder reported before it.
 */
async function acquireRefreshLock(
  target: string,
  options: RefreshLockOptions,
): Promise<() => Promise<void>> {
  const retries = options.retries ?? BLOCKING_RETRIES;
  options.signal?.throwIfAborted();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await lockfile.lock(target, { realpath: false, stale: LOCK_STALE_MS, retries: 0 });
    } catch (err) {
      if (!isLockContention(err)) throw err;
      if (attempt >= retries) {
        (err as RefreshLockError).holder = await readRefreshLockHolder();
        throw err;
      }
      if (attempt === 0) options.onWait?.(await readRefreshLockHolder());
      await sleep(retryDelayMs(attempt), undefined, { signal: options.signal }).catch(
        (sleepErr: unknown) => {
          options.signal?.throwIfAborted();
          throw sleepErr;
        },
      );
    }
  }
}

/**
 * Run `fn` holding the refresh lock, *blocking* until the current holder
 * releases rather than failing fast: a user typing `miner refresh` while the
 * daemon happens to be mid-pass wants their refresh to happen, not an error.
 * A crashed holder's lock goes stale after `LOCK_STALE_MS`.
 */
export async function withRefreshLock<T>(
  fn: () => Promise<T>,
  options: RefreshLockOptions = {},
): Promise<T> {
  const target = refreshLockPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '', { flag: 'a' });
  const release = await acquireRefreshLock(target, options);
  try {
    const holder: RefreshLockHolder = {
      pid: process.pid,
      command: process.argv.slice(1).join(' '),
      startedAt: new Date().toISOString(),
    };
    await atomicWrite(refreshLockHolderPath(), JSON.stringify(holder));
    return await fn();
  } finally {
    await fs.rm(refreshLockHolderPath(), { force: true });
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
  const yieldPoint = options.yieldPoint ?? yieldToEventLoop;
  const lap = lapTimer();
  const phases: Record<string, number> = {};

  try {
    if (options.mode === 'delta') {
      return await runDeltaPass({
        graph,
        transcripts: options.transcripts ?? [],
        yieldPoint,
        taskRoot: options.taskRoot,
        episodeLimit: options.episodeLimit,
        activeRootChanged: options.activeRootChanged,
        activeRoot: options.activeRoot,
        skipWorkspace: options.skipWorkspace,
      });
    }
    if (options.full) {
      // Before the reset, never after: a session whose transcripts Claude Code
      // has pruned cannot be re-derived, and `resetIndex` would take it with
      // everything else. 33 of them on the live graph as of 2026-09-10.
      preserveUnreachable(graph, 'transcript pruned before this rebuild (TP-41)');
      // Both halves, because they share the edge and FTS tables: resetting one
      // alone would leave the other's rows behind their own spans and edges.
      resetIndex(graph);
      resetWorkspaceIndex(graph);
    }
    const discovered =
      options.transcripts ??
      (await (options.root ? discoverTranscripts(options.root) : discoverAllTranscripts()));
    const visiting = discovered.slice(0, options.limit ?? discovered.length);
    const verify = options.verifyHashes ?? options.full ?? false;

    syncPrices(graph, PRICE_TABLE, { tableVersion: PRICE_TABLE_VERSION });
    const offsetsBefore = snapshotOffsets(graph);
    phases.discover = lap();
    const prErrors: string[] = [];
    const summary = await refreshCorpus(graph, visiting, {
      full: options.full,
      verifyHash: verify,
      withContentHash: verify,
      resolveTasks: taskResolver(options.taskRoot),
      resolveOrigins: agentChatOriginResolver(undefined, options.taskRoot),
      resolvePrs: options.skipPrOutcomes
        ? undefined
        : ghPrResolver(graph, { run: options.runGh, errors: prErrors }),
      facetLimit: options.facetLimit,
    });
    phases.corpus = lap();
    // After the rollup, because segmentation reads the wake causes it derives.
    const episodes = await refreshEpisodes(
      graph,
      offsetsBefore,
      options.episodeLimit,
      yieldPoint,
      options.episodeSweep,
    );
    await yieldPoint();
    phases.episodes = lap();

    // After the transcripts, so `mentions` and the task join see the rows the
    // transcript pass just wrote.
    const workspace = options.skipWorkspace
      ? null
      : await refreshWorkspace(graph, {
          activeRoot: options.activeRoot ?? options.taskRoot,
          full: options.full,
        });

    phases.workspace = lap();

    // Last, and unconditionally: idempotent, one statement per preserved row,
    // and running it every pass means a partial or accidental delete heals
    // itself rather than waiting for someone to notice it.
    await yieldPoint();
    const preserved = replayPreserved(graph);
    phases.preserve = lap();

    return {
      kind: 'full',
      startedAt,
      durationMs: Date.now() - started,
      transcripts: discovered.length,
      scanned: visiting.length,
      filesOpened: summary.indexed + summary.rewound + summary.quarantined,
      bytesRead: bytesAdvanced(offsetsBefore, snapshotOffsets(graph)),
      phases,
      indexed: summary.indexed,
      rewound: summary.rewound,
      unchanged: summary.unchanged,
      quarantined: summary.quarantined,
      missing: summary.missing,
      reconciledMissing: summary.markedMissing,
      facetsBackfilled: summary.facetsBackfilled,
      facetBacklog: summary.facetBacklog,
      ...episodes,
      factsAdded: summary.facts,
      turnsRolledUp: summary.turnsRolledUp,
      tasksRequested: summary.tasks.requested,
      tasksApplied: summary.tasks.applied,
      workspace,
      preserved,
      errors: [
        ...(summary.tasks.failed ? [`tasks: ${summary.tasks.error ?? 'resolver failed'}`] : []),
        ...(summary.origins.failed
          ? [`origins: ${summary.origins.error ?? 'resolver failed'}`]
          : []),
        ...(summary.prs.failed ? [`prs: ${summary.prs.error ?? 'resolver failed'}`] : []),
        ...prErrors,
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
