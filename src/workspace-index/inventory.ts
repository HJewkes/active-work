import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { listInitiativeSlugs } from '../lint/index.js';
import { toRelative } from './refs.js';
import { scanWorkspace, type WorkspaceClass } from './scan.js';

/**
 * What the active root holds, indexed or not: `scanWorkspace`'s files plus
 * every file under a `sources/` subdirectory other than `notes/`.
 *
 * Nested sources are counted and listed by path only. The workspace index
 * still skips them, so this walk is also what a coverage report compares
 * the index against: `indexed` is false exactly for the nested ones.
 */

export type InventoryClass = WorkspaceClass | 'nested_source';

export interface InventoryFile {
  class: InventoryClass;
  slug: string;
  /** Relative to the active root, `/`-separated. */
  path: string;
  absolutePath: string;
  size: number;
  mtime: string;
  indexed: boolean;
}

async function readDirents(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every visible regular file under `dir`; symlinks are not followed. */
async function walkFiles(dir: string): Promise<string[]> {
  const entries = (await readDirents(dir)).filter((entry) => !entry.name.startsWith('.'));
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => walkFiles(path.join(dir, entry.name))),
  );
  const own = entries.filter((entry) => entry.isFile()).map((entry) => path.join(dir, entry.name));
  return [...own, ...nested.flat()];
}

async function nestedSourcePaths(activeRoot: string, slug: string): Promise<string[]> {
  const sourcesDir = path.join(activeRoot, slug, 'sources');
  const subdirs = (await readDirents(sourcesDir)).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'notes',
  );
  const files = await Promise.all(subdirs.map((d) => walkFiles(path.join(sourcesDir, d.name))));
  return files.flat();
}

async function describeNested(
  activeRoot: string,
  slug: string,
  absolutePath: string,
): Promise<InventoryFile | null> {
  try {
    const stat = await fs.stat(absolutePath);
    return {
      class: 'nested_source',
      slug,
      path: toRelative(activeRoot, absolutePath),
      absolutePath,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      indexed: false,
    };
  } catch {
    // Vanished between the readdir and the stat.
    return null;
  }
}

/** Nested source files for one initiative, sorted by relative path. */
export async function scanNestedSources(
  activeRoot: string,
  slug: string,
): Promise<InventoryFile[]> {
  const paths = await nestedSourcePaths(activeRoot, slug);
  const described = await Promise.all(paths.map((p) => describeNested(activeRoot, slug, p)));
  return described
    .filter((file): file is InventoryFile => file !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Every file the active root holds per initiative, indexed classes and nested sources alike. */
export async function scanInventory(activeRoot: string): Promise<InventoryFile[]> {
  const [indexed, slugs] = await Promise.all([
    scanWorkspace(activeRoot),
    listInitiativeSlugs(activeRoot),
  ]);
  const nested = await Promise.all(slugs.map((slug) => scanNestedSources(activeRoot, slug)));
  const files: InventoryFile[] = indexed.map((file) => ({ ...file, indexed: true }));
  return [...files, ...nested.flat()].sort((a, b) => a.path.localeCompare(b.path));
}
