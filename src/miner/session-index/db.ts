import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMinerRoot } from '../../utils/paths.js';
import { resetIndex } from './writer.js';

export type SessionIndexDb = Database.Database;

/**
 * Bump whenever `schema.sql` changes *or* whenever a derivation rule changes
 * the shape of an existing column — a `*_ref` format, say. At this table count
 * a single versioned schema file (every statement `IF NOT EXISTS`) is enough —
 * a multi-file migration runner would be more machinery than the problem
 * justifies.
 *
 * 3: AW-91 — `file_ref`/`files.repo` now come from the nearest `.git`
 *    ancestor rather than `basename(cwd)`, so every previously indexed ref is
 *    the wrong shape and must be re-derived.
 */
export const SCHEMA_VERSION = 3;

/**
 * Read from disk rather than inlined as a string so the DDL stays a real
 * `.sql` file (diffable, syntax-highlighted). tsup bundles code but not assets,
 * so `scripts/copy-schema.mjs` (wired as the build's `onSuccess` hook) places
 * `schema.sql` next to the bundle — `import.meta.url` then resolves it in both
 * `src/` (tsx) and `dist/` (published) layouts.
 */
function loadSchemaSql(): string {
  return readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
}

/** The cross-initiative index file, alongside AW-28's miner store. */
export function defaultSessionIndexPath(): string {
  return path.join(getMinerRoot(), 'index.sqlite3');
}

/**
 * Apply `schema.sql` if this database predates `SCHEMA_VERSION`. Idempotent:
 * re-running against an already-migrated database is a no-op.
 *
 * A pre-existing database that predates the current version also has its
 * derived rows cleared and its watermarks rewound, because a version bump can
 * mean "the same JSONL now produces differently shaped rows" (AW-91's
 * `file_ref` change) and not just "there is a new table". Leaving the old rows
 * would mix two ref shapes in one index, which no query can untangle. The next
 * refresh — the daemon's or an explicit `miner refresh` — rebuilds from byte 0,
 * so the upgrade needs no `--full` from the user. A brand-new file
 * (`user_version = 0`, nothing to invalidate) skips the wipe.
 */
export function migrate(db: SessionIndexDb): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;
  const stale = current > 0;
  db.exec('BEGIN');
  try {
    db.exec(loadSchemaSql());
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (stale) resetIndex(db);
}

/**
 * Open (creating if absent) the session-signal index and bring it up to
 * `SCHEMA_VERSION`. WAL keeps the daemon's readers from blocking the indexer's
 * writes; `foreign_keys` is off by default in SQLite and must be set per
 * connection.
 */
export function openSessionIndex(dbPath: string = defaultSessionIndexPath()): SessionIndexDb {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
