/**
 * Recursive filesystem watcher for the active root.
 *
 * Node's `fs.watch(dir, { recursive: true })` is only reliable on macOS and
 * Windows; on Linux recursive support is version-dependent. To stay portable
 * we build the recursion ourselves: watch the root plus every current
 * subdirectory, and re-scan (adding watchers for freshly-created dirs) whenever
 * a change lands. Change events are debounced into a single callback so a burst
 * of atomic writes (temp file + rename) collapses into one broadcast.
 */
import { watch, readdirSync, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';

export interface WatchTreeOptions {
  /** Coalesce bursts of events within this window (ms). */
  debounceMs?: number;
  /** Surface watcher errors (e.g. EMFILE) without crashing the daemon. */
  onError?: (err: unknown) => void;
}

export interface TreeWatcher {
  close: () => void;
  /** Whether a watcher is currently attached to `dir`. */
  isWatching: (dir: string) => boolean;
  /**
   * Resolve once a watcher is attached to `dir` — the real "this path is now
   * covered" signal, so callers never have to guess with a sleep. Resolves
   * `true` immediately if already attached, `false` if `timeoutMs` elapses or
   * the tree watcher is closed first.
   */
  whenWatching: (dir: string, timeoutMs?: number) => Promise<boolean>;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000;

/**
 * Watch `root` and all nested directories, invoking `onChange` (debounced)
 * whenever any file or directory under the tree changes. Returns a handle
 * whose `close()` tears down every underlying watcher.
 */
export function watchTree(
  root: string,
  onChange: () => void,
  options: WatchTreeOptions = {},
): TreeWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const watchers = new Map<string, FSWatcher>();
  const attachWaiters = new Map<string, Set<() => void>>();
  let debounceTimer: NodeJS.Timeout | null = null;
  let rescanTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const fire = (): void => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onChange();
    }, debounceMs);
  };

  const notifyAttached = (dir: string): void => {
    const waiters = attachWaiters.get(dir);
    if (!waiters) return;
    attachWaiters.delete(dir);
    for (const resolve of waiters) resolve();
  };

  const watchDir = (dir: string): void => {
    if (closed || watchers.has(dir)) return;
    let w: FSWatcher;
    try {
      w = watch(dir, { persistent: false });
    } catch (err) {
      options.onError?.(err);
      return;
    }
    w.on('error', (err) => options.onError?.(err));
    w.on('change', () => {
      fire();
      // A new subdirectory may have appeared; pick it up on the next tick.
      scheduleRescan();
    });
    watchers.set(dir, w);
    notifyAttached(dir);
  };

  const scheduleRescan = (): void => {
    if (closed || rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      void addNewDirs(root);
    }, debounceMs);
  };

  /**
   * Walk the whole tree attaching watchers to any directory we do not cover.
   *
   * This descends unconditionally. A previous version only recursed into
   * directories it had just discovered, on the theory that an already-watched
   * directory's children were already covered — but that is false the moment a
   * directory is created *inside* an existing one (`initiative/tasks/`, the
   * shape this codebase actually writes). Those grandchildren were never
   * watched, so every write beneath them was invisible to the live-reload feed
   * and the session-index refresh trigger (AW-44).
   */
  const addNewDirs = async (dir: string): Promise<void> => {
    if (closed) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      options.onError?.(err);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const isNew = !watchers.has(child);
      watchDir(child);
      // Writes can land inside a directory between its creation and our
      // attaching to it; those events are gone. Firing on first attach makes
      // the newly-covered subtree observable rather than silently stale.
      if (isNew && watchers.has(child)) fire();
      await addNewDirs(child);
    }
  };

  // Attach watchers for the whole existing tree *synchronously* so no edit can
  // slip through the gap between `watchTree` returning and an async scan
  // completing — this matters on Linux, where the root watch is non-recursive
  // and nested changes are only seen via the per-directory watchers.
  const addExistingDirsSync = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      options.onError?.(err);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      watchDir(child);
      addExistingDirsSync(child);
    }
  };

  watchDir(root);
  addExistingDirsSync(root);

  const whenWatching = (dir: string, timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS): Promise<boolean> => {
    if (watchers.has(dir)) return Promise.resolve(true);
    if (closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        attachWaiters.get(dir)?.delete(done);
        resolve(watchers.has(dir));
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      const waiters = attachWaiters.get(dir) ?? new Set<() => void>();
      waiters.add(done);
      attachWaiters.set(dir, waiters);
    });
  };

  return {
    isWatching: (dir: string): boolean => watchers.has(dir),
    whenWatching,
    close(): void {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (rescanTimer) clearTimeout(rescanTimer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      for (const waiters of attachWaiters.values()) for (const resolve of waiters) resolve();
      attachWaiters.clear();
    },
  };
}
