import { promises as fs } from 'node:fs';
import type { WorkspaceGraph } from '../session-index/graph.js';
import { toAbsolute } from './refs.js';

/**
 * The check that stands between this index and brain's failure.
 *
 * Brain stored absolute paths, the repository moved, and 5,013 of 5,065 notes
 * detached from files that were sitting on disk the whole time. Nothing
 * detected it, because nothing ever checked that a stored path still opened —
 * a search could return a hit whose citation could not be read, and the system
 * had no way to say so. This is that missing check, and it is cheap.
 */

export interface WorkspaceIndexHealth {
  checked: number;
  /** Indexed rows whose file no longer opens, as `<ref> -> <relative path>`. */
  missing: string[];
}

const INDEXED_REFS = `
  SELECT initiative_ref AS ref, path FROM initiative
  UNION ALL SELECT note_ref,    path FROM note
  UNION ALL SELECT task_ref,    path FROM workspace_task
  UNION ALL SELECT session_ref, path FROM session_record
  UNION ALL SELECT source_ref,  path FROM source
  ORDER BY path
`;

export async function checkWorkspaceIndex(
  graph: WorkspaceGraph,
  activeRoot: string,
): Promise<WorkspaceIndexHealth> {
  const indexed = graph.db.prepare(INDEXED_REFS).all() as { ref: string; path: string }[];
  const results = await Promise.all(
    indexed.map(async (row) => ((await opens(toAbsolute(activeRoot, row.path))) ? null : row)),
  );
  return {
    checked: indexed.length,
    missing: results.filter((row) => row !== null).map((row) => `${row.ref} -> ${row.path}`),
  };
}

async function opens(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
