import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMinerRoot } from '../../utils/paths.js';

export type SessionIndexDb = Database.Database;

/**
 * Bump whenever `schema.sql` changes. At this table count a single versioned
 * schema file (every statement `IF NOT EXISTS`) is enough — a multi-file
 * migration runner would be more machinery than the problem justifies.
 */
export const SCHEMA_VERSION = 1;

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
 */
export function migrate(db: SessionIndexDb): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;
  db.exec('BEGIN');
  try {
    db.exec(loadSchemaSql());
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
