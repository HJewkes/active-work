/**
 * Daemon adapter that keeps the AW-23 session-signal index warm.
 *
 * Same posture as the live-reload watcher: indexing is a nicety, so every
 * failure path here degrades to `null` and a warning rather than aborting the
 * daemon. A failed migration, a better-sqlite3 ABI mismatch after a Node
 * upgrade, or an unreadable transcripts root must not stop `active-work mcp
 * serve` from serving.
 */
import { existsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { claudeTranscriptRoots } from '@titan-design/session-read';
import { watchTree, type TreeWatcher } from '@titan-design/daemon';
import { watchChangedPaths } from '../session-index/watch-paths.js';
import { createDirtySet, type DirtySet, type DrainedDirtySet } from '../session-index/dirty-set.js';
import { transcriptsFromDirty } from '../session-index/delta-pass.js';
import { indexFreshness } from '../session-index/freshness.js';
import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { readMachinePressure, shouldHold } from '../utils/machine-pressure.js';
import { readerGate } from '../session-index/reader-gate.js';
import {
  readRefreshLockHolder,
  runRefresh,
  withRefreshLock,
  type RefreshOptions,
  type RefreshSummary,
} from '../session-index/refresh.js';
import {
  DEFAULT_GATE_RECHECK_MS,
  DEFAULT_MIN_INTERVAL_MS,
  RefreshScheduler,
  type PassKind,
  type SchedulerStatus,
} from '../session-index/scheduler.js';

export interface WatcherStatus extends SchedulerStatus {
  /** The longest the event loop stalled during the last successful pass; null before one. */
  lastMaxLoopStallMs: number | null;
}

export interface SessionIndexWatcher {
  status(): WatcherStatus;
  close(): Promise<void>;
}

interface WatchLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface SessionIndexWatchOptions {
  /** Starts the backstop poll and returns its stop; injectable so a test can fire it by hand. */
  startPoll?: (tick: () => void, intervalMs: number) => () => void;
}

/** Coalesces a burst of watcher events into one dirty-set update. */
const DEFAULT_DEBOUNCE_MS = 2_000;

/**
 * Backstop full pass (TP-787). Readers refresh on demand, so the poll only
 * catches what the watcher missed and runs the whole-corpus phases a delta
 * pass skips. An explicit `AW_INDEX_POLL_MS` is taken as given.
 */
const DEFAULT_POLL_MS = 10 * 60_000;

function startIntervalPoll(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** The longest a pass waits on in-flight related requests before it resumes anyway. */
export const IDLE_CAP_MS = 5_000;

/** Settles with `work`, or rejects with the abort reason as soon as `signal` fires. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The daemon pass's yield point: let I/O in, then hold while a related request runs (TP-343).
 * An aborted `signal` ends the pass here, between chunks, so shutdown loses nothing committed (TP-791).
 */
export async function yieldToReaders(signal?: AbortSignal): Promise<void> {
  await nextMacrotask();
  const idle = readerGate.idle(IDLE_CAP_MS);
  await (signal ? untilAborted(idle, signal) : idle);
}

/** A held lock is routine on a busy machine; log the first skip and then one in this many. */
const LOCK_SKIP_LOG_EVERY = 60;

/** How many of a pass's errors the log line carries; the count covers the rest. */
const LOGGED_ERRORS = 5;

function passLogLine(summary: RefreshSummary, maxStallMs: number): object {
  return {
    kind: summary.kind,
    transcripts: summary.transcripts,
    scanned: summary.scanned,
    filesOpened: summary.filesOpened,
    bytesRead: summary.bytesRead,
    durationMs: summary.durationMs,
    maxStallMs,
    phases: summary.phases,
    errors: summary.errors.slice(0, LOGGED_ERRORS),
    errorCount: summary.errors.length,
  };
}

/** Every this many passes the daemon checks all sessions for stale episodes, not only touched ones. */
const EPISODE_SWEEP_EVERY = 10;

/**
 * Decides which passes sweep the episode backlog: the first, every
 * `EPISODE_SWEEP_EVERY`th, and any pass after one that failed or left a backlog.
 */
function episodeSweepPolicy(): {
  next(): boolean;
  settle(backlog: number | null): void;
  failed(): void;
} {
  let passes = 0;
  let backlogCleared = false;
  return {
    next: () => passes++ % EPISODE_SWEEP_EVERY === 0 || !backlogCleared,
    settle: (backlog) => {
      if (backlog !== null) backlogCleared = backlog === 0;
    },
    failed: () => {
      backlogCleared = false;
    },
  };
}

/** Sampling interval for the stall gauge; a stall shorter than this does not register. */
const STALL_RESOLUTION_MS = 10;

/**
 * Run `fn` and report the longest event-loop stall while it ran. A pass that
 * stops yielding shows here long before agent-chat's related calls time out.
 */
export async function measureLoopStall<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; maxStallMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: STALL_RESOLUTION_MS });
  histogram.enable();
  try {
    const result = await fn();
    return { result, maxStallMs: Math.round(histogram.max / 1e6) };
  } finally {
    histogram.disable();
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Set `AW_INDEX_WATCH=0` to run the daemon with indexing switched off. */
function disabled(): boolean {
  return process.env.AW_INDEX_WATCH === '0';
}

/**
 * One watcher per Claude config dir, since each keeps its own transcripts. A
 * machine that has never run Claude Code under a dir has no root there. That is
 * an ordinary state, not a fault: skip it and let the poll pick it up if it
 * ever appears.
 */
function watchRoot(
  root: string,
  onChange: () => void,
  log: WatchLogger,
  dirty?: DirtySet,
): TreeWatcher | null {
  if (!existsSync(root)) {
    log.info({ root }, 'no transcripts root yet; session indexing will poll for one');
    return null;
  }
  try {
    const debounceMs = envInt('AW_INDEX_DEBOUNCE_MS', DEFAULT_DEBOUNCE_MS);
    const onError = (err: unknown) => log.warn({ err, root }, 'session index watcher error');
    const watcher = dirty
      ? watchChangedPaths(root, dirty, onChange, { debounceMs, onError })
      : watchTree(root, onChange, { debounceMs, onError });
    log.info({ root }, 'watching transcripts for session indexing');
    return watcher;
  } catch (err) {
    log.warn({ err, root }, 'transcript watcher unavailable; falling back to polling');
    return null;
  }
}

export interface PassRunner {
  run(kind: PassKind, onIndexed?: () => void): Promise<RefreshSummary>;
  lastMaxLoopStallMs(): number | null;
}

/**
 * Both kinds drain the dirty set only once the lock is held, and put it back if
 * the pass fails, so no reported change is lost. A delta pass never waits on the
 * lock: a reader is waiting on it, and the next pass picks the paths up.
 */
export function passRunner(
  graph: WorkspaceGraph,
  dirty: DirtySet,
  log: WatchLogger,
  signal: AbortSignal,
): PassRunner {
  let lastMaxLoopStallMs: number | null = null;
  const sweep = episodeSweepPolicy();
  const measured = async (options: RefreshOptions): Promise<RefreshSummary> => {
    const { result, maxStallMs } = await measureLoopStall(() =>
      runRefresh({ graph, yieldPoint: () => yieldToReaders(signal), ...options }),
    );
    lastMaxLoopStallMs = maxStallMs;
    log.info(passLogLine(result, maxStallMs), 'session index pass');
    return result;
  };
  const full = async (drained: DrainedDirtySet): Promise<RefreshSummary> => {
    try {
      const result = await measured({ episodeSweep: sweep.next(), dirtyPaths: drained.paths });
      sweep.settle(result.episodeBacklog);
      return result;
    } catch (err) {
      sweep.failed();
      throw err;
    }
  };
  const run = (kind: PassKind, onIndexed?: () => void): Promise<RefreshSummary> =>
    withRefreshLock(
      async () => {
        const drained = dirty.drain();
        try {
          if (kind === 'full') return await full(drained);
          const roots = claudeTranscriptRoots();
          const transcripts = await transcriptsFromDirty(graph, drained, roots);
          return await measured({ mode: 'delta', transcripts, onIndexed });
        } catch (err) {
          dirty.restore(drained);
          throw err;
        }
      },
      kind === 'delta' ? { retries: 0, signal } : { signal },
    );
  return { run, lastMaxLoopStallMs: () => lastMaxLoopStallMs };
}

function createScheduler(
  runner: PassRunner,
  log: WatchLogger,
  signal: AbortSignal,
): RefreshScheduler {
  return new RefreshScheduler((kind, onIndexed) => runner.run(kind, onIndexed), {
    onError: (err) => {
      if (!signal.aborted) log.warn({ err }, 'session index refresh failed');
    },
    minIntervalMs: envInt('AW_INDEX_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS),
    gate: async () => shouldHold(await readMachinePressure()),
    gateRecheckMs: envInt('AW_INDEX_GATE_RECHECK_MS', DEFAULT_GATE_RECHECK_MS),
    onHoldChange: (held, reason) =>
      log.info({ reason }, held ? `session index paused: ${reason}` : 'session index resumed'),
    onLockSkip: (skips) => {
      if (skips % LOCK_SKIP_LOG_EVERY === 1) {
        void readRefreshLockHolder().then((holder) =>
          log.info(
            { skips, holder },
            'session index refresh skipped: lock held elsewhere; will retry',
          ),
        );
      }
    },
  });
}

/** Readers refresh before they read; nothing to index and nothing running means already fresh. */
function installFreshness(scheduler: RefreshScheduler, dirty: DirtySet): () => void {
  return indexFreshness.install((budgetMs) =>
    dirty.size === 0 && !scheduler.status().running
      ? Promise.resolve('fresh')
      : scheduler.runNow(budgetMs),
  );
}

export function startSessionIndexWatch(
  log: WatchLogger,
  options: SessionIndexWatchOptions = {},
): SessionIndexWatcher | null {
  if (disabled()) {
    log.info({}, 'session index watch disabled by AW_INDEX_WATCH=0');
    return null;
  }

  let graph: WorkspaceGraph;
  try {
    graph = openGraph();
  } catch (err) {
    log.warn({ err }, 'session index unavailable; transcript indexing disabled');
    return null;
  }

  const dirty = createDirtySet();
  const abort = new AbortController();
  const runner = passRunner(graph, dirty, log, abort.signal);
  const scheduler = createScheduler(runner, log, abort.signal);
  const uninstall = installFreshness(scheduler, dirty);

  // The watcher only records what changed; a reader or the poll runs the pass.
  const watchers = claudeTranscriptRoots().flatMap(({ root }) => {
    const watcher = watchRoot(root, () => {}, log, dirty);
    return watcher ? [watcher] : [];
  });

  const startPoll = options.startPoll ?? startIntervalPoll;
  const stopPoll = startPoll(
    () => scheduler.trigger(),
    envInt('AW_INDEX_POLL_MS', DEFAULT_POLL_MS),
  );

  // Un-awaited: a cold corpus takes tens of seconds to index and the daemon
  // must be answering on its port long before that finishes.
  scheduler.trigger();

  return {
    status: () => ({ ...scheduler.status(), lastMaxLoopStallMs: runner.lastMaxLoopStallMs() }),
    async close(): Promise<void> {
      uninstall();
      abort.abort(new Error('session index watcher closed'));
      stopPoll();
      for (const watcher of watchers) watcher.close();
      await scheduler.close();
      graph.db.close();
    },
  };
}
