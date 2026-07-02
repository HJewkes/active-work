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
}

const DEFAULT_DEBOUNCE_MS = 200;

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
  };

  const scheduleRescan = (): void => {
    if (closed || rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      void addNewDirs(root);
    }, debounceMs);
  };

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
      if (isNew) await addNewDirs(child);
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

  return {
    close(): void {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (rescanTimer) clearTimeout(rescanTimer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}
