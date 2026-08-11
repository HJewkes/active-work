/**
 * AW-101: `tasks.*` filled from the active-work store.
 *
 * This is the only place the index reads outside the transcript corpus, so the
 * tests that matter are the ones pinning what that licenses and what it does
 * not: the store wins on every pass (unlike transcript-derived columns, where
 * the first sighting wins), and a ref the store cannot resolve UNAMBIGUOUSLY
 * stays null rather than being guessed at.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { reconcileTasks } from '../../../src/miner/session-index/rollup.js';
import { loadTaskStore } from '../../../src/miner/session-index/task-store.js';

let dir: string;
let storeRoot: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-task-store-'));
  storeRoot = path.join(dir, 'active');
  mkdirSync(storeRoot, { recursive: true });
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
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

const addRef = (id: string): void => {
  db.prepare('INSERT INTO tasks (task_ref) VALUES (?)').run(`task:${id}`);
};

const rowFor = (id: string): Record<string, unknown> | undefined =>
  db.prepare('SELECT * FROM tasks WHERE task_ref = ?').get(`task:${id}`) as
    | Record<string, unknown>
    | undefined;

async function reconcile(): Promise<number> {
  return reconcileTasks(db, await loadTaskStore(storeRoot));
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

describe('reconcileTasks', () => {
  it('fills every column the transcript cannot supply', async () => {
    writeTask('alpha', 'A-1', {
      title: 'Wire the thing',
      status: 'done',
      created: '2026-08-01',
      done_at: '2026-08-05',
    });
    addRef('A-1');

    await reconcile();

    expect(rowFor('A-1')).toEqual({
      task_ref: 'task:A-1',
      initiative: 'alpha',
      title: 'Wire the thing',
      status: 'done',
      created_at: '2026-08-01',
      completed_at: '2026-08-05',
    });
  });

  it('leaves an ambiguous ref null rather than picking one', async () => {
    writeTask('health', 'H-1', { title: 'Swim' });
    writeTask('herald', 'H-1', { title: 'Ship the digest' });
    addRef('H-1');

    await reconcile();

    expect(rowFor('H-1')).toMatchObject({ initiative: null, title: null, status: null });
  });

  // `parseTaskId` reads any `[A-Z]{1,5}-\d+` token, so `ISO-8601` becomes a ref.
  it('leaves a ref the store has never heard of null', async () => {
    writeTask('alpha', 'A-1');
    addRef('ISO-8601');

    await reconcile();

    expect(rowFor('ISO-8601')).toMatchObject({ initiative: null, title: null });
  });

  it('does not invent rows for tasks the corpus never cited', async () => {
    writeTask('alpha', 'A-1');
    writeTask('alpha', 'A-2');
    addRef('A-1');

    await reconcile();

    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
  });

  // The opposite of the COALESCE merges used for transcript-derived columns:
  // there the first sighting is the fact, here the store is, so a later pass
  // must overwrite rather than keep what it already had.
  it('overwrites on a later pass when the store has moved on', async () => {
    writeTask('alpha', 'A-1', { title: 'Old title', status: 'open' });
    addRef('A-1');
    await reconcile();

    writeTask('alpha', 'A-1', { title: 'New title', status: 'done', done_at: '2026-08-09' });
    await reconcile();

    expect(rowFor('A-1')).toMatchObject({
      title: 'New title',
      status: 'done',
      completed_at: '2026-08-09',
    });
  });
});
