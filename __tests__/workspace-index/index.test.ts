import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import { refreshWorkspace } from '../../src/workspace-index/refresh.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from '../../src/workspace-index/schema.js';
import { removeFile, scaffold, SHARED_SESSION_ID, writeFile } from './fixture.js';

/**
 * What the index says, as opposed to whether it says it consistently. The
 * consistency claim is `convergence.test.ts`; this is the content.
 */

let dir: string;
let root: string;
let graph: WorkspaceGraph;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-ws-index-'));
  root = path.join(dir, 'active-root');
  scaffold(root);
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  await refreshWorkspace(graph, { activeRoot: root });
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = <T>(sql: string, ...params: unknown[]): T[] =>
  graph.db.prepare(sql).all(...params) as T[];

describe('workspace rows', () => {
  it('keeps both a live task and its archived copy, which share one task ref', () => {
    const filed = rows<{ path: string; status: string }>(
      'SELECT path, status FROM workspace_task WHERE task_ref = ? ORDER BY path',
      'task:AL-1',
    );

    // Keyed by ref these would be one row and the winner would depend on scan
    // order. Keyed by path both survive and the ref namespace is unharmed.
    expect(filed).toEqual([
      { path: 'alpha/tasks/AL-1.yml', status: 'open' },
      { path: 'alpha/tasks/archive/AL-1.yml', status: 'done' },
    ]);
  });

  it('keeps one row per session file when two initiatives record the same session id', () => {
    const records = rows<{ path: string; initiative: string }>(
      'SELECT path, initiative FROM session_record WHERE session_id = ? ORDER BY path',
      SHARED_SESSION_ID,
    );

    expect(records.map((r) => r.initiative)).toEqual(['alpha', 'beta']);
  });

  it('indexes every initiative, not one', () => {
    expect(rows('SELECT slug FROM initiative ORDER BY slug')).toEqual([
      { slug: 'alpha' },
      { slug: 'beta' },
    ]);
  });
});

describe('relative paths', () => {
  // Post-mortem finding F1: brain stored absolute paths, the repository moved,
  // and 5,013 of 5,065 notes detached from files that were sitting there the
  // whole time. Asserted with a query rather than by inspection.
  it('stores no absolute path in any indexed column', () => {
    const tables = ['initiative', 'note', 'workspace_task', 'session_record', 'source'];
    for (const table of tables) {
      const absolute = rows(`SELECT path FROM "${table}" WHERE path LIKE '/%'`);
      expect({ table, absolute }).toEqual({ table, absolute: [] });
    }
    expect(rows("SELECT source_key FROM workspace_file WHERE source_key LIKE '/%'")).toEqual([]);
  });

  it('resolves every stored path back to a file that opens', async () => {
    const { checkWorkspaceIndex } = await import('../../src/workspace-index/doctor.js');

    expect(await checkWorkspaceIndex(graph, root)).toEqual({
      checked: expect.any(Number),
      missing: [],
    });
  });
});

describe('the session join', () => {
  it('reaches a mined transcript session from a workspace session record by shared ref', () => {
    // The payoff of the colliding `session:` ref. The transcript half is
    // written by `@titan-design/session-graph`; this stands in for it.
    graph.db
      .prepare('INSERT INTO session (session_id, started_at, turn_count) VALUES (?, ?, ?)')
      .run('alpha-one', '2026-09-02T09:00:00Z', 12);

    const joined = rows<{ path: string; turn_count: number }>(
      `SELECT r.path, s.turn_count
         FROM session_record r
         JOIN session s ON r.session_ref = 'session:' || s.session_id
        ORDER BY r.path`,
    );

    expect(joined).toEqual([
      { path: 'alpha/sessions/2026-09-02-0900-alpha-one.md', turn_count: 12 },
    ]);
  });
});

describe('derived edges', () => {
  const edges = (relation: string) =>
    rows<{ source_ref: string; target_ref: string }>(
      'SELECT source_ref, target_ref FROM edge WHERE relation = ? ORDER BY source_ref, target_ref',
      relation,
    );

  it('holds every record from the initiative its path names', () => {
    const held = edges('holds').filter((e) => e.source_ref === 'initiative:beta');

    expect(held.map((e) => e.target_ref)).toContain('task:BE-7');
    expect(held.map((e) => e.target_ref)).toContain('source:beta/design.md');
  });

  it('mentions a task in another initiative that a note body names', () => {
    expect(edges('mentions')).toContainEqual({
      source_ref: 'note:alpha/2026-09-02-alpha-lesson.md',
      target_ref: 'task:BE-7',
    });
  });

  it('resolves a bare sources/ path inside the mentioning note own initiative', () => {
    expect(edges('mentions')).toContainEqual({
      source_ref: 'note:beta/2026-09-02-beta-lesson.md',
      target_ref: 'source:beta/design.md',
    });
  });

  it('shares a tag only across an initiative boundary', () => {
    const shared = edges('shares_tag');

    // `worktree` spans alpha and beta, so it links. `process` is carried by an
    // alpha note and a beta note too — but the pair it would add inside one
    // initiative is what the cross-initiative filter drops.
    expect(shared).toContainEqual({
      source_ref: 'note:alpha/2026-09-02-alpha-lesson.md',
      target_ref: 'note:beta/2026-09-02-beta-lesson.md',
    });
    for (const edge of shared) {
      expect(edge.source_ref.split('/')[0]).not.toBe(edge.target_ref.split('/')[0]);
    }
  });

  it('writes no similarity edge, and only the three declared relations', () => {
    expect(rows('SELECT DISTINCT relation FROM edge ORDER BY relation')).toEqual([
      { relation: 'holds' },
      { relation: 'mentions' },
      { relation: 'shares_tag' },
    ]);
  });
});

describe('FTS spans', () => {
  it('tags every workspace span source id so it cannot collide with a transcript', () => {
    const below = rows(
      'SELECT span_id FROM search_span WHERE source_id < ?',
      WORKSPACE_SPAN_SOURCE_BASE,
    );

    expect(below).toEqual([]);
  });

  it('finds a source body through the shared contentless index', () => {
    const hits = graph.spans.search('"Prose a search should find"');

    expect(hits.map((h) => h.ownerRef)).toEqual(['source:beta/design.md']);
  });

  it('resolves a span locator back to the exact bytes of the file', async () => {
    const { readFileSync } = await import('node:fs');
    const hit = graph.spans.search('"The indexer was written"')[0];
    const relative = graph.db
      .prepare('SELECT source_key FROM workspace_file WHERE source_id = ?')
      .get(hit.sourceId - WORKSPACE_SPAN_SOURCE_BASE) as { source_key: string };

    const bytes = readFileSync(path.join(root, relative.source_key)).subarray(
      hit.byteOffset,
      hit.byteOffset + hit.byteLength,
    );

    expect(bytes.toString('utf8')).toContain('The indexer was written');
  });

  it('cannot return a span whose file was deleted', async () => {
    removeFile(root, 'beta/sources/design.md');
    await refreshWorkspace(graph, { activeRoot: root });

    expect(graph.spans.search('"Prose a search should find"')).toEqual([]);
    expect(rows('SELECT path FROM source WHERE path = ?', 'beta/sources/design.md')).toEqual([]);
  });

  it('purges spans through an index rather than by scanning the table', () => {
    // Not a micro-optimisation. The kit indexes `search_span` on `owner_ref`
    // only, and every purge here goes by `source_id`; without this index a full
    // pass over the live root took 5.2 seconds against 89,533 existing spans,
    // and 0.6 with it. A future migration dropping the index would be an 8x
    // regression with no other symptom.
    const plan = rows<{ detail: string }>(
      'EXPLAIN QUERY PLAN DELETE FROM search_span WHERE source_id = 1',
    );

    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_search_span_source');
  });
});

describe('malformed files', () => {
  it('drops the rows of a file that stops parsing and names it', async () => {
    writeFile(root, 'beta/tasks/BE-7.yml', 'id: not-a-task-id\nthis: is not a task\n');

    const summary = await refreshWorkspace(graph, { activeRoot: root });

    expect(summary.malformed.map((m) => m.path)).toEqual(['beta/tasks/BE-7.yml']);
    expect(rows('SELECT path FROM workspace_task WHERE path = ?', 'beta/tasks/BE-7.yml')).toEqual(
      [],
    );
  });
});
