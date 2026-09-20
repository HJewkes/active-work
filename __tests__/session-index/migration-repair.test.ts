/**
 * TP-257: a graph whose `_migration` rows were numbered before active-work had
 * a fixed band is repaired on open, so session-graph's version 3 stops being
 * shadowed and `conversation` finally gets created.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph, openGraphReadOnly } from '../../src/session-index/graph.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { MIGRATIONS } from '../../src/workspace-index/schema.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

/**
 * The live shape from `~/Library/Application Support/active-work/.miner/graph.sqlite3`:
 * session-graph's version 3 shadowed by active-work's, and `preserved rows`
 * recorded twice because the positional numbering shifted under it.
 */
const COLLIDED_ROWS: [number, string][] = [
  [1, 'kit tables'],
  [2, 'session graph tables'],
  [3, 'workspace index tables'],
  [4, 'preserved rows'],
  [5, 'preserved rows'],
];

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-migration-repair-'));
  dbPath = path.join(dir, 'graph.sqlite3');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the real migration bodies, but record them the way the pre-band build did. */
function seedCollidedGraph(): void {
  const db = new Database(dbPath);
  db.exec(
    'CREATE TABLE _migration (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL)',
  );
  const insert = db.prepare('INSERT INTO _migration (version, name, applied_at) VALUES (?, ?, ?)');
  const applied = new Set<string>();
  for (const [version, name] of COLLIDED_ROWS) {
    const migration = MIGRATIONS.find((m) => m.name === name);
    if (migration && !applied.has(name)) migration.up(db);
    applied.add(name);
    insert.run(version, name, '2026-09-01T00:00:00.000Z');
  }
  db.close();
}

function migrationRows(): { version: number; name: string }[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT version, name FROM _migration ORDER BY version').all() as {
      version: number;
      name: string;
    }[];
  } finally {
    db.close();
  }
}

function hasTable(name: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined
    );
  } finally {
    db.close();
  }
}

describe('openGraph on a graph with colliding migration numbers', () => {
  it('repairs the live collision', () => {
    seedCollidedGraph();
    expect(hasTable('conversation')).toBe(false);

    openGraph(dbPath).db.close();

    expect(migrationRows()).toEqual([
      { version: 1, name: 'kit tables' },
      { version: 2, name: 'session graph tables' },
      { version: 3, name: 'normalized conversations and source evidence' },
      { version: 1001, name: 'workspace index tables' },
      { version: 1002, name: 'preserved rows' },
    ]);
    expect(hasTable('conversation')).toBe(true);
  });

  it('is a no-op on a fresh database', () => {
    openGraph(dbPath).db.close();
    const fresh = migrationRows();

    openGraph(dbPath).db.close();

    expect(migrationRows()).toEqual(fresh);
    expect(fresh.map((r) => r.version)).toEqual([1, 2, 3, 1001, 1002]);
  });

  it('is idempotent across two opens', () => {
    seedCollidedGraph();
    openGraph(dbPath).db.close();
    const repaired = migrationRows();

    openGraph(dbPath).db.close();

    expect(migrationRows()).toEqual(repaired);
  });

  it('a refresh pass succeeds after repair', async () => {
    seedCollidedGraph();
    const root = path.join(dir, 'projects');
    mkdirSync(path.join(root, 'demo'), { recursive: true });
    writeFileSync(path.join(root, 'demo', 'a.jsonl'), renderTranscript(FIXTURE_LINES), 'utf8');

    const graph = openGraph(dbPath);
    try {
      const summary = await runRefresh({ graph, root });
      expect(summary).toMatchObject({ indexed: 1, errors: [] });
    } finally {
      graph.db.close();
    }
  });

  it('leaves the unrepaired shape alone when opened read-only', () => {
    seedCollidedGraph();

    openGraphReadOnly(dbPath).close();

    expect(migrationRows()).toEqual(
      COLLIDED_ROWS.map(([version, name]) => ({ version, name })),
    );
  });
});
