/**
 * Auto-archive stale done tasks during bootstrap (AW-8).
 *
 * A `done` task whose `done_at` is older than `retentionDays` is moved from
 * `tasks/<id>.yml` into `tasks/archive/<id>.yml`. Every task reader filters by
 * the `.yml`/`.yaml` extension, so the `archive/` subdirectory is naturally
 * excluded from the active list while the file is preserved for recovery.
 *
 * Best-effort: unreadable/malformed task files and per-file move failures are
 * skipped rather than aborting the bootstrap.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readYaml } from '../utils/yaml-io.js';
import { TaskSchema } from '../schemas/task.js';

const MS_PER_DAY = 86_400_000;

export interface ArchiveStaleTasksOptions {
  /** Done tasks whose `done_at` is older than this many days are archived. */
  retentionDays: number;
  /** Reference time (injectable for tests). */
  now: Date;
}

/**
 * Move stale done tasks into `tasks/archive/`. Returns the archived task ids
 * (sorted). A non-positive `retentionDays` disables archiving.
 */
export async function archiveStaleTasks(
  initiativeDir: string,
  opts: ArchiveStaleTasksOptions,
): Promise<string[]> {
  if (!(opts.retentionDays > 0)) return [];
  const tasksDir = path.join(initiativeDir, 'tasks');
  let entries: string[];
  try {
    entries = await fsp.readdir(tasksDir);
  } catch {
    return [];
  }
  const ymlFiles = entries.filter(
    (n) => n.endsWith('.yml') || n.endsWith('.yaml'),
  );
  const cutoffMs = opts.now.getTime() - opts.retentionDays * MS_PER_DAY;
  const archiveDir = path.join(tasksDir, 'archive');
  const archived: string[] = [];

  for (const filename of ymlFiles) {
    const fullPath = path.join(tasksDir, filename);
    let doneAt: string | null;
    let id: string;
    try {
      const task = await readYaml(fullPath, TaskSchema);
      if (task.status !== 'done' || !task.done_at) continue;
      doneAt = task.done_at;
      id = task.id;
    } catch {
      continue; // malformed / unreadable — leave it in place
    }
    const doneMs = new Date(doneAt).getTime();
    if (Number.isNaN(doneMs) || doneMs > cutoffMs) continue;
    try {
      await fsp.mkdir(archiveDir, { recursive: true });
      await fsp.rename(fullPath, path.join(archiveDir, filename));
      archived.push(id);
    } catch {
      // best-effort: skip files we can't move
    }
  }
  return archived.sort();
}
