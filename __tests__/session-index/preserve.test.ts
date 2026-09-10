import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetIndex } from '@titan-design/session-graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import {
  forgetPreserved,
  listPreserved,
  preserveRow,
  replayPreserved,
} from '../../src/session-index/preserve.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { resetWorkspaceIndex } from '../../src/workspace-index/write.js';

/**
 * The 19 sessions TP-23 lost, in miniature.
 *
 * A rebuild re-derives from the transcripts, so a session whose transcript
 * Claude Code has pruned cannot come back — and `resetIndex` clears the row
 * that a manual recovery put there. These assert that declaring a row
 * non-derivable survives exactly that.
 */

let dir: string;
let graph: WorkspaceGraph;

const PRUNED = {
  session_id: 'pruned-882-turn-session',
  started_at: '2026-06-01T10:00:00Z',
  turn_count: 882,
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-preserve-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertPruned(): void {
  graph.db
    .prepare(
      'INSERT INTO session (session_id, started_at, turn_count) VALUES (@session_id, @started_at, @turn_count)',
    )
    .run(PRUNED);
  preserveRow(graph, {
    table: 'session',
    identity: ['session_id'],
    key: PRUNED.session_id,
    payload: PRUNED,
    origin: 'recovered from the retired index.sqlite3 (TP-41)',
    mode: 'insert',
  });
}

const sessions = (): { session_id: string; turn_count: number }[] =>
  graph.db.prepare('SELECT session_id, turn_count FROM session').all() as {
    session_id: string;
    turn_count: number;
  }[];

describe('preserved rows', () => {
  it('survives the reset that would otherwise erase them', () => {
    insertPruned();

    resetIndex(graph);
    expect(sessions()).toEqual([]);

    expect(replayPreserved(graph)).toEqual({ restored: 1, merged: 0, skipped: 0 });
    expect(sessions()).toEqual([{ session_id: PRUNED.session_id, turn_count: 882 }]);
  });

  it('is replayed by an ordinary refresh, so a full rebuild does not need a second command', async () => {
    insertPruned();
    // A corpus root with no transcripts: nothing can re-derive the row, which
    // is precisely the situation a pruned transcript leaves behind.
    const corpus = path.join(dir, 'projects');
    mkdirSync(corpus, { recursive: true });

    const summary = await runRefresh({
      graph,
      root: corpus,
      full: true,
      activeRoot: path.join(dir, 'active'),
    });

    expect(summary.preserved).toEqual({ restored: 1, merged: 0, skipped: 0 });
    expect(sessions()).toEqual([{ session_id: PRUNED.session_id, turn_count: 882 }]);
  });

  it('yields to derivation when the real source comes back', () => {
    insertPruned();
    resetIndex(graph);
    graph.db
      .prepare('INSERT INTO session (session_id, started_at, turn_count) VALUES (?, ?, ?)')
      .run(PRUNED.session_id, PRUNED.started_at, 900);

    expect(replayPreserved(graph)).toEqual({ restored: 0, merged: 0, skipped: 1 });
    // The transcript's own count, not the copy's: a preserved row fills a gap,
    // it never overrides a source that can speak for itself.
    expect(sessions()).toEqual([{ session_id: PRUNED.session_id, turn_count: 900 }]);
  });

  it('merges a column onto a row derivation did produce', () => {
    // The general answer the sessions case buys: `note.hits` is the one column
    // in the workspace index not derivable from the files, and this is how its
    // reset-to-zero becomes revisitable rather than permanent (TP-27).
    graph.db
      .prepare(
        `INSERT INTO note (path, note_ref, initiative, filename, kind, title)
         VALUES ('a/sources/notes/n.md', 'note:a/n.md', 'a', 'n.md', 'process', 'A note')`,
      )
      .run();
    preserveRow(graph, {
      table: 'note',
      identity: ['note_ref'],
      key: 'note:a/n.md',
      payload: { hits: 4 },
      origin: 'retrieval hit counter',
      mode: 'merge',
    });

    expect(replayPreserved(graph)).toEqual({ restored: 0, merged: 1, skipped: 0 });
    expect(graph.db.prepare('SELECT hits FROM note').get()).toEqual({ hits: 4 });
  });

  it('records where a row came from, and can be told to stop', () => {
    insertPruned();

    expect(listPreserved(graph)).toEqual([
      expect.objectContaining({ origin: 'recovered from the retired index.sqlite3 (TP-41)' }),
    ]);
    expect(forgetPreserved(graph, 'session', PRUNED.session_id)).toBe(true);
    expect(listPreserved(graph)).toEqual([]);
  });

  it('declares a session whose transcript is gone, so --full stops destroying it', async () => {
    // The mechanism is only a fix if something uses it. Nobody hand-declares a
    // row before a rebuild, so the rebuild declares them itself.
    graph.db
      .prepare("INSERT INTO transcript (source_key, status) VALUES ('~/gone.jsonl', 'missing')")
      .run();
    const gone = graph.db.prepare('SELECT source_id FROM transcript').get() as {
      source_id: number;
    };
    graph.db
      .prepare('INSERT INTO session (session_id, started_at, turn_count) VALUES (?, ?, ?)')
      .run('pruned', '2026-06-01T10:00:00Z', 882);
    graph.db
      .prepare(
        `INSERT INTO fact (transcript_id, byte_offset, byte_length, event_type, ts, seq, session_id)
         VALUES (?, 0, 10, 'prompt', '2026-06-01T10:00:00Z', 0, 'pruned')`,
      )
      .run(gone.source_id);

    const corpus = path.join(dir, 'projects');
    mkdirSync(corpus, { recursive: true });
    const summary = await runRefresh({
      graph,
      root: corpus,
      full: true,
      activeRoot: path.join(dir, 'active'),
    });

    expect(sessions()).toEqual([{ session_id: 'pruned', turn_count: 882 }]);
    expect(summary.preserved.restored).toBeGreaterThan(0);
  });

  it('does not duplicate a row on a table with no UNIQUE over its identity', () => {
    // `permission_phase` is keyed by an auto-assigned `phase_id` and constrains
    // nothing else, so `INSERT OR IGNORE` has no conflict to ignore. Replay runs
    // on every pass, so an unguarded insert compounds silently: measured on the
    // live graph, 38 rows per refresh, forever.
    const phase = {
      session_id: 'pruned',
      from_mode: null,
      to_mode: 'acceptEdits',
      trigger: 'command',
      t_valid: '2026-06-01T10:00:00Z',
      t_invalid: null,
    };
    const columns = Object.keys(phase);
    graph.db
      .prepare(
        `INSERT INTO permission_phase (${columns.join(', ')})
         VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
      )
      .run(phase);
    preserveRow(graph, {
      table: 'permission_phase',
      identity: ['session_id', 't_valid', 'to_mode'],
      key: `${phase.session_id}:${phase.t_valid}:${phase.to_mode}`,
      payload: phase,
      origin: 'recovered from the retired index.sqlite3 (TP-41)',
      mode: 'insert',
    });

    const count = () =>
      (graph.db.prepare('SELECT COUNT(*) c FROM permission_phase').get() as { c: number }).c;

    expect(replayPreserved(graph)).toEqual({ restored: 0, merged: 0, skipped: 1 });
    expect(replayPreserved(graph)).toEqual({ restored: 0, merged: 0, skipped: 1 });
    expect(count()).toBe(1);

    resetIndex(graph);
    expect(replayPreserved(graph)).toEqual({ restored: 1, merged: 0, skipped: 0 });
    expect(replayPreserved(graph)).toEqual({ restored: 0, merged: 0, skipped: 1 });
    expect(count()).toBe(1);
  });

  it('refuses a declaration whose identity a rebuild could not match', () => {
    // The identity columns have to be in the payload, or the replay's existence
    // check reads undefined and the guard silently stops guarding.
    expect(() =>
      preserveRow(graph, {
        table: 'session',
        identity: ['session_id'],
        key: 'x',
        payload: { turn_count: 1 },
        origin: 'test',
        mode: 'insert',
      }),
    ).toThrow(/missing session_id/);
  });

  it('is not cleared by either reset, which is the whole mechanism', () => {
    insertPruned();

    resetIndex(graph);
    resetWorkspaceIndex(graph);

    expect(listPreserved(graph)).toHaveLength(1);
  });
});
