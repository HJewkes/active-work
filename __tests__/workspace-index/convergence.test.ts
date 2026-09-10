import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import { refreshWorkspace } from '../../src/workspace-index/refresh.js';
import { resetWorkspaceIndex } from '../../src/workspace-index/write.js';
import { refreshInto, removeFile, scaffold, writeFile } from './fixture.js';

/**
 * Acceptance item 1, and the test everything else here depends on: a full
 * rebuild and a sequence of incremental passes must produce identical rows.
 *
 * Written first on purpose. Every other property of this index — deletion,
 * relative paths, the derived edges — is only safe to assert once "the index
 * says the same thing however it got there" is nailed down, because each of
 * them is a place where an incremental pass could take a shortcut a rebuild
 * does not.
 */

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-ws-converge-'));
  root = path.join(dir, 'active-root');
  scaffold(root);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Everything the index derives, minus the clocks. `t_created` and `t_valid`
 * record when a row was written, so two runs necessarily differ there; the
 * claim under test is about content, not about wall time.
 */
function dump(graph: WorkspaceGraph): Record<string, unknown[]> {
  const all = (sql: string): unknown[] => graph.db.prepare(sql).all();
  return {
    initiative: all('SELECT * FROM initiative ORDER BY path'),
    note: all('SELECT * FROM note ORDER BY path'),
    workspace_task: all('SELECT * FROM workspace_task ORDER BY path'),
    session_record: all('SELECT * FROM session_record ORDER BY path'),
    source: all('SELECT * FROM source ORDER BY path'),
    edge: all(
      'SELECT source_ref, relation, target_ref FROM edge ORDER BY source_ref, relation, target_ref',
    ),
    span: all(
      'SELECT owner_ref, field, byte_offset, byte_length FROM search_span ORDER BY owner_ref, field, byte_offset',
    ),
    fts: all(
      `SELECT s.owner_ref, s.field FROM search_fts f
         JOIN search_span s ON s.span_id = f.rowid
        ORDER BY s.owner_ref, s.field, s.byte_offset`,
    ),
  };
}

async function rebuild(): Promise<Record<string, unknown[]>> {
  const graph = await refreshInto(path.join(dir, 'full.sqlite3'), root, true);
  try {
    return dump(graph);
  } finally {
    graph.db.close();
  }
}

async function incremental(
  stages: (() => void)[],
): Promise<{ dump: Record<string, unknown[]>; passes: number }> {
  const dbPath = path.join(dir, 'incremental.sqlite3');
  const graph = openGraph(dbPath);
  let passes = 0;
  try {
    for (const stage of stages) {
      stage();
      await refreshWorkspace(graph, { activeRoot: root });
      passes++;
    }
    return { dump: dump(graph), passes };
  } finally {
    graph.db.close();
  }
}

describe('workspace index convergence', () => {
  it('reaches the same rows whether the corpus arrives at once or a file at a time', async () => {
    const staged = await incremental([
      () => {},
      () => writeFile(root, 'alpha/tasks/AL-2.yml', taskYaml('AL-2', 'A task filed later')),
      () =>
        writeFile(
          root,
          'alpha/sources/notes/2026-09-04-late.md',
          noteMd('A late note', ['worktree'], 'It names AL-2, which did not exist a pass ago.'),
        ),
    ]);

    expect(staged.passes).toBe(3);
    expect(staged.dump).toEqual(await rebuild());
  });

  it('re-reads a file rewritten in place and replaces its rows rather than adding to them', async () => {
    const staged = await incremental([
      () => {},
      () => writeFile(root, 'alpha/tasks/AL-1.yml', taskYaml('AL-1', 'Retitled after the fact')),
    ]);

    expect(staged.dump).toEqual(await rebuild());
    const titles = staged.dump.workspace_task as { title: string }[];
    expect(titles.map((t) => t.title)).toContain('Retitled after the fact');
  });

  it('deletes the rows of a file that disappears, leaving the same state as never having had it', async () => {
    const staged = await incremental([
      () => {},
      () => removeFile(root, 'beta/sources/notes/2026-09-03-beta-second.md'),
    ]);

    expect(staged.dump).toEqual(await rebuild());
  });

  it('resolves a mention that only becomes resolvable when its target is filed', async () => {
    // The reason `mentions` is rebuilt from every note body every pass rather
    // than only for notes whose watermark moved: this note does not change, but
    // what it means does.
    writeFile(
      root,
      'alpha/sources/notes/2026-09-05-forward.md',
      noteMd('A forward reference', [], 'BE-9 does not exist yet.'),
    );
    const staged = await incremental([
      () => {},
      () => writeFile(root, 'beta/tasks/BE-9.yml', taskYaml('BE-9', 'Filed after the note')),
    ]);

    expect(staged.dump).toEqual(await rebuild());
    const mentions = (staged.dump.edge as { relation: string; target_ref: string }[]).filter(
      (e) => e.relation === 'mentions' && e.target_ref === 'task:BE-9',
    );
    expect(mentions).toHaveLength(1);
  });

  it('rewinds and rebuilds identically after a reset of an already-populated index', async () => {
    const dbPath = path.join(dir, 'reset.sqlite3');
    const graph = openGraph(dbPath);
    try {
      await refreshWorkspace(graph, { activeRoot: root });
      const before = dump(graph);

      resetWorkspaceIndex(graph);
      graph.db.exec("DELETE FROM edge WHERE relation IN ('holds','mentions','shares_tag')");
      graph.db.exec('DELETE FROM search_span');
      graph.spans.clearIndex();
      await refreshWorkspace(graph, { activeRoot: root });

      expect(dump(graph)).toEqual(before);
    } finally {
      graph.db.close();
    }
  });
});

function taskYaml(id: string, title: string): string {
  return [
    `id: ${id}`,
    `title: ${title}`,
    'priority: 2',
    'done_when: it converges',
    'notes: more text',
    'status: open',
    'created: 2026-09-01',
    'updated: 2026-09-04',
    'done_at: null',
    '',
  ].join('\n');
}

function noteMd(title: string, tags: string[], body: string): string {
  return [
    '---',
    'kind: gotcha',
    `title: ${title}`,
    'created: 2026-09-04',
    ...(tags.length > 0 ? ['tags:', ...tags.map((t) => `  - ${t}`)] : []),
    '---',
    '',
    body,
    '',
  ].join('\n');
}
