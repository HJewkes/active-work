import Database from 'better-sqlite3';
import { openSessionGraph, type SessionGraph } from '@titan-design/session-graph';
import { runMigrations, WatermarkTable } from '@titan-design/store-sqlite';
import path from 'node:path';
import { getMinerRoot } from '../utils/paths.js';
import { MIGRATIONS, WORKSPACE_KIT } from '../workspace-index/schema.js';

/**
 * active-work's binding of `@titan-design/session-graph`: where the graph file
 * lives, how to open it read-only, and the workspace tables active-work adds on
 * top of the package's chain.
 *
 * The package owns its own schema, so nothing here describes a session-graph
 * table. What active-work still decides is the path — under `getMinerRoot()`,
 * so `ACTIVE_ROOT` overrides and test isolation keep working — and the
 * workspace half of the same file (TP-24).
 */

export type { SessionGraph };

/**
 * The session graph plus what the workspace pass needs: one watermark table
 * over the workspace files. `edges` and `spans` are shared with the transcript
 * side on purpose, because cross-class retrieval is a join.
 */
export interface WorkspaceGraph extends SessionGraph {
  workspaceFiles: WatermarkTable;
}

/**
 * The schema version the code expects, derived from the migration chain rather
 * than declared next to it (TP-35). `miner status` reports it.
 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * The cross-initiative graph file.
 *
 * Deliberately not the `index.sqlite3` that `src/miner/` wrote: that file
 * carries the retired AW-23 schema under `PRAGMA user_version`, and the
 * package's migration runner tracks versions in its own table. Pointing the new
 * runner at the old file would leave two version records disagreeing about the
 * same database. A new name makes the cutover a rebuild, which is what it is.
 */
export function defaultGraphPath(): string {
  return path.join(getMinerRoot(), 'graph.sqlite3');
}

/**
 * Open (creating if absent) the graph, migrating it to `SCHEMA_VERSION`.
 *
 * Two calls, not one: `openSessionGraph` applies the package's chain, then
 * `runMigrations` applies the whole chain including active-work's workspace
 * migration. The kit's runner records applied versions in `_migration` and
 * skips them, so the package's are re-checked rather than re-run.
 */
export function openGraph(dbPath: string = defaultGraphPath()): WorkspaceGraph {
  const graph = openSessionGraph(dbPath);
  runMigrations(graph.db, MIGRATIONS);
  return {
    ...graph,
    workspaceFiles: new WatermarkTable(graph.db, { name: WORKSPACE_KIT.watermark }),
  };
}

/**
 * Open without migrating — for diagnostics, which must be able to *look at* a
 * graph without changing it.
 *
 * Opening is not a read: `openGraph` runs migrations, and a migration is free
 * to rewrite rows. That is intended for the indexer, which rebuilds
 * immediately afterwards. It is emphatically not intended for `miner status` or
 * `miner liveness`, where it turns "tell me about the index" into "rewrite the
 * index" with no prompt — as it did once, to a real 155 MB corpus, while this
 * very command was being written.
 */
export function openGraphReadOnly(dbPath: string = defaultGraphPath()): Database.Database {
  return new Database(dbPath, { readonly: true });
}
