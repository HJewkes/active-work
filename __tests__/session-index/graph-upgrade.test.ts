/**
 * TP-3743: a graph last written by a build pinned to an older session-graph
 * stops at the package's version 8. Opening it through `openGraph` must carry
 * it through every later package migration, so a read-only reader built on the
 * current package stops refusing it.
 */
import Database from 'better-sqlite3';
import { openSessionGraph } from '@titan-design/session-graph';
import { runMigrations } from '@titan-design/store-sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph } from '../../src/session-index/graph.js';
import { MIGRATIONS } from '../../src/workspace-index/schema.js';

const OLD_PACKAGE_TOP = 8;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-graph-upgrade-'));
  dbPath = path.join(dir, 'graph.sqlite3');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The shape the old writer left: package migrations through 8, plus active-work's band. */
function seedVersionEightGraph(): void {
  const db = new Database(dbPath);
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version <= OLD_PACKAGE_TOP || m.version > 1000),
  );
  db.close();
}

function appliedVersions(): number[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT version FROM _migration ORDER BY version').all() as {
      version: number;
    }[];
    return rows.map((r) => r.version);
  } finally {
    db.close();
  }
}

function priceColumns(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('PRAGMA table_info(price)').all() as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

describe('openGraph on a graph left at session-graph version 8', () => {
  it('applies the package migrations 9 through 13', () => {
    seedVersionEightGraph();
    expect(appliedVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 1001, 1002]);

    openGraph(dbPath).db.close();

    expect(appliedVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1001, 1002]);
    expect(priceColumns().some((c) => c.startsWith('long_'))).toBe(true);
  });

  it('lets the package open the upgraded graph read-only', () => {
    seedVersionEightGraph();
    expect(() => openSessionGraph(dbPath, { readonly: true })).toThrow(/migrations 9/);

    openGraph(dbPath).db.close();

    const graph = openSessionGraph(dbPath, { readonly: true });
    graph.db.close();
  });
});
