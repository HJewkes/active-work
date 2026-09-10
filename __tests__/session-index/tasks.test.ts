/**
 * AW-101 / TP-22: the `task` rows filled from the active-work store, through
 * `@titan-design/session-graph`'s `TaskResolver` seam.
 *
 * This is the only thing the index reads outside the transcript corpus, so the
 * tests that matter are the ones pinning what that licenses and what it does
 * not: the store wins on every pass (unlike transcript-derived columns, where
 * the first sighting wins), and a ref the store cannot resolve UNAMBIGUOUSLY
 * stays null rather than being guessed at.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { allTaskIds, enrichTasks } from '@titan-design/session-graph';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { loadTaskStore, taskResolver } from '../../src/session-index/tasks.js';

let dir: string;
let storeRoot: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-task-store-'));
  storeRoot = path.join(dir, 'active');
  mkdirSync(storeRoot, { recursive: true });
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeTask(
  slug: string,
  id: string,
  fields: Partial<{ title: string; status: string; created: string; done_at: string }> = {},
): void {
  const tasks = path.join(storeRoot, slug, 'tasks');
  mkdirSync(tasks, { recursive: true });
  const body = [
    `id: ${id}`,
    `title: ${fields.title ?? `Do ${id}`}`,
    'priority: 10',
    `status: ${fields.status ?? 'open'}`,
    `created: ${fields.created ?? '2026-08-01'}`,
    `updated: ${fields.created ?? '2026-08-01'}`,
    `done_at: ${fields.done_at ?? 'null'}`,
  ].join('\n');
  writeFileSync(path.join(tasks, `${id}.yml`), body + '\n', 'utf8');
}

/** A task ref as a transcript leaves it: an id, and nothing else known. */
const addRef = (id: string, status: string | null = null): void => {
  graph.db
    .prepare('INSERT INTO task (task_ref, task_id, status) VALUES (?, ?, ?)')
    .run(`task:${id}`, id, status);
};

const rowFor = (id: string): Record<string, unknown> | undefined =>
  graph.db.prepare('SELECT * FROM task WHERE task_ref = ?').get(`task:${id}`) as
    | Record<string, unknown>
    | undefined;

async function enrich(): Promise<number> {
  const result = await enrichTasks(graph, taskResolver(storeRoot), allTaskIds(graph));
  return result.applied;
}

describe('loadTaskStore', () => {
  it('reads every initiative under the root', async () => {
    writeTask('alpha', 'A-1');
    writeTask('beta', 'B-2');

    const store = await loadTaskStore(storeRoot);

    expect(store.get('A-1')).toMatchObject({ initiative: 'alpha', title: 'Do A-1' });
    expect(store.get('B-2')).toMatchObject({ initiative: 'beta' });
  });

  // Real collision: `health` and `herald` both mint `H-<n>`.
  it('marks an id two initiatives both claim as unresolvable', async () => {
    writeTask('health', 'H-1', { title: 'Swim' });
    writeTask('herald', 'H-1', { title: 'Ship the digest' });

    const store = await loadTaskStore(storeRoot);

    expect(store.has('H-1')).toBe(true);
    expect(store.get('H-1')).toBeNull();
  });

  it('survives a malformed task file rather than failing the pass', async () => {
    writeTask('alpha', 'A-1');
    mkdirSync(path.join(storeRoot, 'broken', 'tasks'), { recursive: true });
    writeFileSync(path.join(storeRoot, 'broken', 'tasks', 'X-1.yml'), 'id: [not a task\n', 'utf8');

    const store = await loadTaskStore(storeRoot);

    expect(store.get('A-1')).toMatchObject({ initiative: 'alpha' });
    expect(store.has('X-1')).toBe(false);
  });

  it('is empty rather than throwing when the root does not exist', async () => {
    expect(await loadTaskStore(path.join(dir, 'nope'))).toEqual(new Map());
  });
});

describe('the task resolver', () => {
  it('fills every column the transcript cannot supply', async () => {
    writeTask('alpha', 'A-1', { title: 'Wire the thing', status: 'done' });
    addRef('A-1');

    await enrich();

    expect(rowFor('A-1')).toEqual({
      task_ref: 'task:A-1',
      task_id: 'A-1',
      initiative: 'alpha',
      title: 'Wire the thing',
      status: 'done',
    });
  });

  // TP-20 derives a status from the command a transcript witnessed. The store
  // is the system of record for the status a task holds *now*, so it wins.
  it('takes the store status over the one the transcript derived', async () => {
    writeTask('alpha', 'A-1', { status: 'open' });
    addRef('A-1', 'done');

    await enrich();

    expect(rowFor('A-1')).toMatchObject({ status: 'open' });
  });

  it('leaves an ambiguous ref alone rather than picking one', async () => {
    writeTask('health', 'H-1', { title: 'Swim' });
    writeTask('herald', 'H-1', { title: 'Ship the digest' });
    addRef('H-1');

    await enrich();

    expect(rowFor('H-1')).toMatchObject({ initiative: null, title: null, status: null });
  });

  // `parseTaskId` reads any `[A-Z]{1,5}-\d+` token, so `ISO-8601` becomes a ref.
  it('leaves a ref the store has never heard of alone', async () => {
    writeTask('alpha', 'A-1');
    addRef('ISO-8601');

    await enrich();

    expect(rowFor('ISO-8601')).toMatchObject({ initiative: null, title: null });
  });

  /**
   * The resolver answers only what it was asked. Returning the whole store
   * would insert every task in every initiative, which the seam permits and
   * this index does not want: `task` means "tasks the corpus mentions".
   */
  it('does not invent rows for tasks the corpus never cited', async () => {
    writeTask('alpha', 'A-1');
    writeTask('alpha', 'A-2');
    addRef('A-1');

    await enrich();

    expect(graph.db.prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual({ n: 1 });
  });

  // The opposite of the COALESCE merges used for transcript-derived columns:
  // there the first sighting is the fact, here the store is, so a later pass
  // must overwrite rather than keep what it already had.
  it('overwrites on a later pass when the store has moved on', async () => {
    writeTask('alpha', 'A-1', { title: 'Old title', status: 'open' });
    addRef('A-1');
    await enrich();

    writeTask('alpha', 'A-1', { title: 'New title', status: 'done', done_at: '2026-08-09' });
    await enrich();

    expect(rowFor('A-1')).toMatchObject({ title: 'New title', status: 'done' });
  });
});
