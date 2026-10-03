import path from 'node:path';

export interface DrainedDirtySet {
  /** Absolute paths of `.jsonl` files a watcher reported. */
  paths: string[];
  /** Roots where an event arrived without a file name, so any file may have changed. */
  unknownRoots: string[];
}

export interface DirtySet {
  /** `null` means the platform coalesced the file name away: the whole root is suspect. */
  add(root: string, relPath: string | null): void;
  drain(): DrainedDirtySet;
  readonly size: number;
}

export function createDirtySet(): DirtySet {
  let paths = new Set<string>();
  let unknownRoots = new Set<string>();
  return {
    add(root, relPath) {
      if (relPath === null) {
        unknownRoots.add(root);
        return;
      }
      if (relPath.endsWith('.jsonl')) paths.add(path.join(root, relPath));
    },
    drain() {
      const drained = { paths: [...paths], unknownRoots: [...unknownRoots] };
      paths = new Set();
      unknownRoots = new Set();
      return drained;
    },
    get size() {
      return paths.size + unknownRoots.size;
    },
  };
}
