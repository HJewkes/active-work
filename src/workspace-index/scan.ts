import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { listInitiativeSlugs } from '../lint/index.js';
import { toRelative } from './refs.js';

/**
 * What the active root holds, as a flat list of files.
 *
 * Discovery is deliberately a directory walk with no sidecar manifest, for the
 * same reason `listSources` reads `sources/` every time it is asked: a
 * hand-maintained list eventually omits a file someone dropped in by hand, and
 * a derived index that disagrees with the files is the failure this whole
 * design exists to avoid.
 */

export type WorkspaceClass = 'initiative' | 'note' | 'task' | 'session' | 'source';

export interface WorkspaceFile {
  class: WorkspaceClass;
  slug: string;
  /** Relative to the active root, `/`-separated. This is the watermark key and the row's primary key. */
  path: string;
  absolutePath: string;
  size: number;
  /** `mtime` and `size` together decide whether to re-read; see `refresh.ts`. */
  mtime: string;
}

async function readDirents(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isVisible(entry: Dirent, extensions: readonly string[]): boolean {
  return (
    entry.isFile() &&
    !entry.name.startsWith('.') &&
    extensions.some((ext) => entry.name.endsWith(ext))
  );
}

async function filesIn(dir: string, extensions: readonly string[]): Promise<string[]> {
  const entries = await readDirents(dir);
  return entries
    .filter((entry) => isVisible(entry, extensions))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * Tasks recurse one level so `tasks/archive/` is indexed too: 255 of the
 * corpus's 920 task files live there, and a closed task is still something
 * `search` should find. Two of them share a `task:` id with their live
 * counterpart, which is why rows are keyed by path rather than by ref.
 */
async function taskFiles(tasksDir: string): Promise<string[]> {
  const own = await filesIn(tasksDir, ['.yml', '.yaml']);
  const archive = await filesIn(path.join(tasksDir, 'archive'), ['.yml', '.yaml']);
  return [...own, ...archive];
}

/**
 * `sources/` top level only, matching `listSources`. `sources/notes/` is the
 * durable-notes store with its own class, and one `youtube/sources/` subtree
 * alone holds 7,753 ingested files that active-work has never called sources.
 */
async function collectSlug(activeRoot: string, slug: string): Promise<[WorkspaceClass, string][]> {
  const dir = path.join(activeRoot, slug);
  const brief = path.join(dir, 'brief.md');
  const [notes, tasks, sessions, sources] = await Promise.all([
    filesIn(path.join(dir, 'sources', 'notes'), ['.md']),
    taskFiles(path.join(dir, 'tasks')),
    filesIn(path.join(dir, 'sessions'), ['.md']),
    filesIn(path.join(dir, 'sources'), ['.md']),
  ]);
  return [
    ...notes.map((p): [WorkspaceClass, string] => ['note', p]),
    ...tasks.map((p): [WorkspaceClass, string] => ['task', p]),
    ...sessions.map((p): [WorkspaceClass, string] => ['session', p]),
    ...sources.map((p): [WorkspaceClass, string] => ['source', p]),
    ...((await exists(brief)) ? [['initiative', brief] as [WorkspaceClass, string]] : []),
  ];
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function describe(
  activeRoot: string,
  slug: string,
  entry: [WorkspaceClass, string],
): Promise<WorkspaceFile | null> {
  const [cls, absolutePath] = entry;
  try {
    const stat = await fs.stat(absolutePath);
    return {
      class: cls,
      slug,
      path: toRelative(activeRoot, absolutePath),
      absolutePath,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    // Vanished between the readdir and the stat; the next pass will not see it.
    return null;
  }
}

/** Every indexable file under the active root, sorted by relative path. */
export async function scanWorkspace(activeRoot: string): Promise<WorkspaceFile[]> {
  const slugs = await listInitiativeSlugs(activeRoot);
  const perSlug = await Promise.all(
    slugs.map(async (slug) => {
      const entries = await collectSlug(activeRoot, slug);
      const described = await Promise.all(entries.map((e) => describe(activeRoot, slug, e)));
      return described.filter((file): file is WorkspaceFile => file !== null);
    }),
  );
  return perSlug.flat().sort((a, b) => a.path.localeCompare(b.path));
}
