import type Database from 'better-sqlite3';
import {
  PRESERVE_MIGRATION_VERSION,
  WORKSPACE_MIGRATION_VERSION,
} from '../workspace-index/schema.js';

/**
 * Move active-work's own `_migration` rows out of session-graph's numbering and
 * into the fixed band (TP-257).
 *
 * Databases created before the band exists record `workspace index tables` at
 * version 3 and `preserved rows` at 4 (and sometimes 5, from a second
 * positional shift). Version 3 is session-graph 0.5.0's normalized tables, so
 * the runner treats that migration as applied and never creates `conversation`.
 * Renumbering the two rows frees the slot, and the next `runMigrations` applies
 * the package's chain the way it always should have.
 *
 * Kept in its own module so the same repair can move behind an explicit command
 * without touching the open path (open question Q1).
 */

/** Versions below this belong to the package; the band above it is active-work's. */
const BAND_FLOOR = 1000;

const RENUMBERED: ReadonlyArray<readonly [name: string, version: number]> = [
  ['workspace index tables', WORKSPACE_MIGRATION_VERSION],
  ['preserved rows', PRESERVE_MIGRATION_VERSION],
];

/** The versions this repair wrote, empty when the database needed nothing. */
export function repairMigrationBand(db: Database.Database): number[] {
  if (!hasMigrationTable(db)) return [];
  const repaired: number[] = [];
  db.transaction(() => {
    for (const [name, version] of RENUMBERED) {
      if (renumber(db, name, version)) repaired.push(version);
    }
  })();
  return repaired;
}

/**
 * Matching on the exact name is what keeps a session-graph row safe: its
 * migrations carry different names, so they are never selected.
 */
function renumber(db: Database.Database, name: string, version: number): boolean {
  const legacy = db
    .prepare('SELECT applied_at FROM _migration WHERE name = ? AND version < ? ORDER BY version')
    .all(name, BAND_FLOOR) as { applied_at: string }[];
  if (legacy.length === 0) return false;

  db.prepare('DELETE FROM _migration WHERE name = ? AND version < ?').run(name, BAND_FLOOR);
  db.prepare('INSERT OR IGNORE INTO _migration (version, name, applied_at) VALUES (?, ?, ?)').run(
    version,
    name,
    legacy[0].applied_at,
  );
  return true;
}

function hasMigrationTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migration'")
    .get();
  return row !== undefined;
}
