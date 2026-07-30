import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_VERSION, migrate, openSessionIndex } from '../../../src/miner/session-index/db.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-session-index-'));
  dbPath = path.join(dir, 'nested', 'index.sqlite3');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const EXPECTED_TABLES = [
  'transcripts',
  'facts',
  'sessions',
  'session_model_usage',
  'model_pricing',
  'turns',
  'permission_phases',
  'human_edits',
  'prs',
  'branches',
  'files',
  'tasks',
  'subagents',
  'artifacts',
  'edges',
  'searchable_spans',
  'spans_fts',
];

const EXPECTED_INDICES = [
  'idx_facts_session_ts',
  'idx_facts_prompt',
  'idx_facts_tool_use',
  'idx_facts_agent',
  'idx_sessions_started',
  'idx_smu_model',
  'idx_turns_session',
  'idx_permphases_session',
  'idx_human_edits_session',
  'idx_human_edits_file',
  'idx_subagents_session',
  'idx_edges_source',
  'idx_edges_target',
  'idx_edges_current',
  'idx_spans_fact',
];

function names(db: ReturnType<typeof openSessionIndex>, type: 'table' | 'index'): string[] {
  return db
    .prepare<[string], { name: string }>('SELECT name FROM sqlite_master WHERE type = ?')
    .all(type)
    .map((r) => r.name);
}

describe('session index migration', () => {
  it('creates every table and index on a fresh database file', () => {
    const db = openSessionIndex(dbPath);

    expect(names(db, 'table')).toEqual(expect.arrayContaining(EXPECTED_TABLES));
    expect(names(db, 'index')).toEqual(expect.arrayContaining(EXPECTED_INDICES));
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('enables WAL and foreign key enforcement on the connection', () => {
    const db = openSessionIndex(dbPath);

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('is a no-op when re-run against an already-migrated database', () => {
    const first = openSessionIndex(dbPath);
    first.prepare("INSERT INTO transcripts (path) VALUES ('~/a.jsonl')").run();
    const tablesBefore = names(first, 'table').sort();
    first.close();

    const second = openSessionIndex(dbPath);
    migrate(second);

    expect(names(second, 'table').sort()).toEqual(tablesBefore);
    expect(second.prepare('SELECT COUNT(*) AS n FROM transcripts').get()).toEqual({ n: 1 });
    second.close();
  });

  it('keeps the edge current-state indices partial on t_expired IS NULL', () => {
    const db = openSessionIndex(dbPath);

    const sql = db
      .prepare<
        [],
        { name: string; sql: string }
      >("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_edges%'")
      .all();

    expect(sql).toHaveLength(3);
    for (const row of sql) expect(row.sql).toContain('WHERE t_expired IS NULL');
    db.close();
  });

  it('rejects an insert that violates a foreign key', () => {
    const db = openSessionIndex(dbPath);

    const insertOrphanFact = () =>
      db
        .prepare(
          'INSERT INTO facts (transcript_id, byte_offset, byte_length, event_type, ts, seq, session_id)' +
            " VALUES (999, 0, 10, 'user_prompt', '2026-07-30T00:00:00Z', 0, 's1')",
        )
        .run();

    expect(insertOrphanFact).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});
