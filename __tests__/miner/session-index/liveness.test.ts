/**
 * The liveness report exists to answer "which declared structures does nothing
 * populate?" — so the tests that matter are the ones proving it does not lie in
 * either direction: no false alarm on a populated structure, and no silence on
 * an empty one. A diagnostic that cries wolf gets ignored, which is worse than
 * not having it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { runLiveness } from '../../../src/miner/session-index/liveness.js';

let dir: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-liveness-'));
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addSession(id: string): void {
  db.prepare('INSERT INTO sessions (session_id, turn_count) VALUES (?, 0)').run(id);
}

function addEdge(source: string, relation: string, target: string): void {
  db.prepare(
    "INSERT INTO edges (source_ref, relation, target_ref, t_valid) VALUES (?, ?, ?, '2026-08-01')",
  ).run(source, relation, target);
}

const columnFor = (report: ReturnType<typeof runLiveness>, table: string, column: string) =>
  report.columns.find((entry) => entry.table === table && entry.column === column);

describe('liveness report', () => {
  it('reports a column nothing writes, and not one that has values', () => {
    addSession('s-1');

    const report = runLiveness(db);

    // `start_type` is nullable and unset here; `session_id` is the primary key.
    expect(report.emptyColumns).toContainEqual(
      expect.objectContaining({ table: 'sessions', column: 'start_type' }),
    );
    expect(report.emptyColumns).not.toContainEqual(
      expect.objectContaining({ table: 'sessions', column: 'session_id' }),
    );
  });

  it('stays silent about an empty table, where a null column means nothing', () => {
    // No sessions at all: every column is trivially empty, and reporting them
    // would bury the real findings under noise.
    const report = runLiveness(db);

    expect(report.emptyColumns.filter((entry) => entry.table === 'sessions')).toEqual([]);
    expect(columnFor(report, 'sessions', 'start_type')).toMatchObject({ rows: 0, nonNull: 0 });
  });

  it('separates a declared-but-unwritten relation from an undeclared one', () => {
    addSession('s-1');
    addEdge('session:s-1', 'invented_by_nobody', 'session:s-1');

    const report = runLiveness(db);

    expect(report.relations).toContainEqual({
      relation: 'invented_by_nobody',
      count: 1,
      declared: false,
    });
    expect(report.relations).toContainEqual({ relation: 'linked', count: 0, declared: true });
  });

  it('does not report a resolvable session endpoint as dangling', () => {
    // Regression: `sessions` stores the bare id while every other entity table
    // stores the prefixed ref. Comparing naively called all 13,170 session
    // endpoints dangling on the real corpus.
    addSession('s-1');
    addEdge('session:s-1', 'touched', 'session:s-1');

    const report = runLiveness(db);

    expect(report.refNamespaces).toContainEqual({ namespace: 'session', edges: 2, dangling: 0 });
  });

  it('reports an endpoint whose entity really is absent', () => {
    addSession('s-1');
    addEdge('session:s-1', 'touched', 'session:ghost');

    const report = runLiveness(db);

    expect(report.refNamespaces).toContainEqual({ namespace: 'session', edges: 2, dangling: 1 });
  });

  it('flags a ref namespace it cannot resolve rather than passing it silently', () => {
    addSession('s-1');
    addEdge('session:s-1', 'linked', 'pr:acme/demo#1');

    const report = runLiveness(db);

    expect(report.refNamespaces).toContainEqual({ namespace: 'pr', edges: 1, dangling: null });
  });
});
