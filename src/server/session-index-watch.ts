/**
 * Daemon adapter that keeps the AW-23 session-signal index warm.
 *
 * Same posture as the live-reload watcher: indexing is a nicety, so every
 * failure path here degrades to `null` and a warning rather than aborting the
 * daemon. A missing `dist/schema.sql`, a better-sqlite3 ABI mismatch after a
 * Node upgrade, or an unreadable transcripts root must not stop `active-work
 * mcp serve` from serving.
 */
import { existsSync } from 'node:fs';
import { openSessionIndex, type SessionIndexDb } from '../miner/session-index/db.js';
import { transcriptsRoot } from '../miner/session-index/discover.js';
import { runRefresh, withRefreshLock } from '../miner/session-index/refresh.js';
import { RefreshScheduler, type SchedulerStatus } from '../miner/session-index/scheduler.js';
import { watchTree, type TreeWatcher } from './file-watch.js';

export interface SessionIndexWatcher {
  status(): SchedulerStatus;
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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Set `AW_INDEX_WATCH=0` to run the daemon with indexing switched off. */
function disabled(): boolean {
  return process.env.AW_INDEX_WATCH === '0';
}

export function startSessionIndexWatch(log: WatchLogger): SessionIndexWatcher | null {
  if (disabled()) {
    log.info({}, 'session index watch disabled by AW_INDEX_WATCH=0');
    return null;
  }

  let db: SessionIndexDb;
  try {
    db = openSessionIndex();
  } catch (err) {
    log.warn({ err }, 'session index unavailable; transcript indexing disabled');
    return null;
  }

  const scheduler = new RefreshScheduler(() => withRefreshLock(() => runRefresh({ db })), {
    onError: (err) => log.warn({ err }, 'session index refresh failed'),
  });

  const root = transcriptsRoot();
  let watcher: TreeWatcher | null = null;
  // A machine that has never run Claude Code has no transcripts root. That is
  // an ordinary state, not a fault: skip the watcher and let the poll pick the
  // directory up if it ever appears.
  if (existsSync(root)) {
    try {
      watcher = watchTree(root, () => scheduler.trigger(), {
        debounceMs: envInt('AW_INDEX_DEBOUNCE_MS', DEFAULT_DEBOUNCE_MS),
        onError: (err) => log.warn({ err }, 'session index watcher error'),
      });
      log.info({ root }, 'watching transcripts for session indexing');
    } catch (err) {
      log.warn({ err, root }, 'transcript watcher unavailable; falling back to polling');
    }
  } else {
    log.info({ root }, 'no transcripts root yet; session indexing will poll for one');
  }

  const poll = setInterval(() => scheduler.trigger(), envInt('AW_INDEX_POLL_MS', DEFAULT_POLL_MS));
  poll.unref();

  // Un-awaited: a cold corpus takes tens of seconds to index and the daemon
  // must be answering on its port long before that finishes.
  scheduler.trigger();

  return {
    status: () => scheduler.status(),
    async close(): Promise<void> {
      clearInterval(poll);
      watcher?.close();
      await scheduler.close();
      db.close();
    },
  };
}
