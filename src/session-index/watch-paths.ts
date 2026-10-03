import { watch } from 'node:fs';
import { watchTree, type TreeWatcher, type WatchTreeOptions } from '@titan-design/daemon';
import type { DirtySet } from './dirty-set.js';

type WatchOptions = Pick<WatchTreeOptions, 'debounceMs' | 'onError'>;

/**
 * Feed `dirty` with what changed under `root`, then call `onChange` once the
 * events settle. Darwin has recursive `fs.watch` over FSEvents, which names the
 * file; elsewhere `watchTree` only says "something changed", so the whole root
 * is marked unknown.
 */
export function watchChangedPaths(
  root: string,
  dirty: DirtySet,
  onChange: () => void,
  { debounceMs = 0, onError }: WatchOptions,
): TreeWatcher {
  if (process.platform !== 'darwin') {
    return watchTree(
      root,
      () => {
        dirty.add(root, null);
        onChange();
      },
      { debounceMs, onError },
    );
  }
  let timer: NodeJS.Timeout | null = null;
  const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
    dirty.add(root, filename ?? null);
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
    timer.unref();
  });
  watcher.on('error', (err) => onError?.(err));
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
    isWatching: () => true,
    whenWatching: () => Promise.resolve(true),
  };
}
