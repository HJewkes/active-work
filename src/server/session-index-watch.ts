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
import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { readerGate } from '../session-index/reader-gate.js';
import { runRefresh, withRefreshLock } from '../session-index/refresh.js';
import { RefreshScheduler, type SchedulerStatus } from '../session-index/scheduler.js';

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

/**
 * Transcript writes arrive continuously during an active session, so the
 * debounce is an order of magnitude longer than the live-reload watcher's:
 * coalescing two seconds of appends into one pass is the difference between
 * indexing and thrashing.
 */
const DEFAULT_DEBOUNCE_MS = 2_000;

/**
 * Fallback poll. `fs.watch` misses events on network filesystems and after a
 * watcher hits EMFILE, so the index converges on a timer even when no
 * notification ever arrives.
 */
const DEFAULT_POLL_MS = 60_000;

/** The longest a pass waits on in-flight related requests before it resumes anyway. */
export const IDLE_CAP_MS = 5_000;

/** The daemon pass's yield point: let I/O in, then hold while a related request runs (TP-343). */
export async function yieldToReaders(): Promise<void> {
  await nextMacrotask();
  await readerGate.idle(IDLE_CAP_MS);
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
function watchRoot(root: string, onChange: () => void, log: WatchLogger): TreeWatcher | null {
  if (!existsSync(root)) {
    log.info({ root }, 'no transcripts root yet; session indexing will poll for one');
    return null;
  }
  try {
    const watcher = watchTree(root, onChange, {
      debounceMs: envInt('AW_INDEX_DEBOUNCE_MS', DEFAULT_DEBOUNCE_MS),
      onError: (err) => log.warn({ err, root }, 'session index watcher error'),
    });
    log.info({ root }, 'watching transcripts for session indexing');
    return watcher;
  } catch (err) {
    log.warn({ err, root }, 'transcript watcher unavailable; falling back to polling');
    return null;
  }
}

export function startSessionIndexWatch(log: WatchLogger): SessionIndexWatcher | null {
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

  let lastMaxLoopStallMs: number | null = null;
  const pass = async () => {
    const measured = await measureLoopStall(() =>
      runRefresh({ graph, yieldPoint: yieldToReaders }),
    );
    lastMaxLoopStallMs = measured.maxStallMs;
    return measured.result;
  };
  const scheduler = new RefreshScheduler(() => withRefreshLock(pass), {
    onError: (err) => log.warn({ err }, 'session index refresh failed'),
  });

  const watchers = claudeTranscriptRoots().flatMap(({ root }) => {
    const watcher = watchRoot(root, () => scheduler.trigger(), log);
    return watcher ? [watcher] : [];
  });

  const poll = setInterval(() => scheduler.trigger(), envInt('AW_INDEX_POLL_MS', DEFAULT_POLL_MS));
  poll.unref();

  // Un-awaited: a cold corpus takes tens of seconds to index and the daemon
  // must be answering on its port long before that finishes.
  scheduler.trigger();

  return {
    status: () => ({ ...scheduler.status(), lastMaxLoopStallMs }),
    async close(): Promise<void> {
      clearInterval(poll);
      for (const watcher of watchers) watcher.close();
      await scheduler.close();
      graph.db.close();
    },
  };
}
