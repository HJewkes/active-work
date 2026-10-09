import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — importing a plain .mjs (no type declarations) from a test.
import { planEdgeMigration, renderUnresolved } from '../../scripts/migrate-edges.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'migrate-edges.mjs');

interface PlanLine {
  slug: string;
  id: string;
  ops: Record<string, string>[];
}

interface Migration {
  lines: PlanLine[];
  unresolved: { slug: string; id: string; tag: string; reason: string; detail?: string }[];
  counts: {
    edges: Record<string, number>;
    already_fields: Record<string, number>;
    unresolved: Record<string, number>;
    tasks_touched: number;
  };
}

function task(id: string, tags: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    id,
    title: 'Synthetic task',
    priority: 1,
    status: 'open',
    tags,
    created: '2026-01-01',
    updated: '2026-01-01',
    done_at: null,
    ...extra,
  };
}

function plan(bySlug: Record<string, ReturnType<typeof task>[]>): Migration {
  return planEdgeMigration(new Map(Object.entries(bySlug))) as Migration;
}

describe('planEdgeMigration', () => {
  it('turns parent, dep and blocks tags into set_parent and add_dep lines', () => {
    const result = plan({
      alpha: [
        task('AL-1'),
        task('AL-2', ['epic:AL-1', 'dep:AL-3']),
        task('AL-3', ['blocked-by:BE-1']),
        task('AL-4', ['parent:AL-1', 'blocks:AL-3']),
      ],
      beta: [task('BE-1')],
    });

    expect(result.lines).toEqual([
      { slug: 'alpha', id: 'AL-2', ops: [{ set_parent: 'AL-1' }] },
      { slug: 'alpha', id: 'AL-2', ops: [{ add_dep: 'AL-3' }] },
      { slug: 'alpha', id: 'AL-3', ops: [{ add_dep: 'BE-1' }] },
      { slug: 'alpha', id: 'AL-4', ops: [{ set_parent: 'AL-1' }] },
      { slug: 'alpha', id: 'AL-3', ops: [{ add_dep: 'AL-4' }] },
    ]);
    expect(result.counts.edges).toEqual({ parent: 2, dep: 2, blocks: 1, total: 5 });
    expect(result.counts.tasks_touched).toBe(3);
    expect(result.unresolved).toEqual([]);
  });

  it('lists tags naming no task and ids filed twice instead of guessing', () => {
    const result = plan({
      alpha: [task('AL-1', ['epic:some-epic-slug', 'dep:AL-404', 'dep:DU-1', 'blocks:AL-1'])],
      beta: [task('DU-1')],
      gamma: [task('DU-1')],
    });

    expect(result.lines).toEqual([]);
    expect(result.unresolved).toEqual([
      { slug: 'alpha', id: 'AL-1', tag: 'epic:some-epic-slug', reason: 'not-a-task-id' },
      { slug: 'alpha', id: 'AL-1', tag: 'dep:AL-404', reason: 'unknown-id' },
      { slug: 'alpha', id: 'AL-1', tag: 'dep:DU-1', reason: 'ambiguous-id', detail: 'beta, gamma' },
      { slug: 'alpha', id: 'AL-1', tag: 'blocks:AL-1', reason: 'self-reference' },
    ]);
    expect(result.counts.unresolved).toMatchObject({ 'unknown-id': 1, total: 4 });
  });

  it('lists a task with two parents, or a parent elsewhere, and sets no parent', () => {
    const result = plan({
      alpha: [
        task('AL-1'),
        task('AL-2'),
        task('AL-3', ['epic:AL-1', 'parent:AL-2']),
        task('AL-4', ['epic:AL-1'], { parent: 'AL-2' }),
        task('AL-5', ['epic:BE-1']),
      ],
      beta: [task('BE-1')],
    });

    expect(result.lines).toEqual([]);
    expect(result.unresolved.map((u) => [u.id, u.reason])).toEqual([
      ['AL-3', 'two-parents'],
      ['AL-4', 'two-parents'],
      ['AL-5', 'parent-in-other-initiative'],
    ]);
  });

  it('skips an edge the field already holds and emits a repeated edge once', () => {
    const result = plan({
      alpha: [
        task('AL-1', ['blocks:AL-2']),
        task('AL-2', ['dep:AL-1', 'epic:AL-3'], { parent: 'AL-3' }),
        task('AL-3'),
      ],
    });

    expect(result.lines).toEqual([{ slug: 'alpha', id: 'AL-2', ops: [{ add_dep: 'AL-1' }] }]);
    expect(result.counts.already_fields).toEqual({ set_parent: 1, add_dep: 0 });
  });

  it('renders the unresolved list as a markdown table', () => {
    const text = renderUnresolved([
      { slug: 'alpha', id: 'AL-1', tag: 'dep:AL-404', reason: 'unknown-id' },
    ]) as string;

    expect(text).toContain('| alpha | AL-1 | dep:AL-404 | unknown-id |  |');
  });
});

describe('scripts/migrate-edges.mjs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'aw-migrate-edges-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(slug: string, value: ReturnType<typeof task>): string {
    const file = path.join(dir, 'root', slug, 'tasks', `${value.id}.yml`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, YAML.stringify(value));
    return file;
  }

  it('writes the plan and unresolved list and leaves every task file as it was', () => {
    seed('alpha', task('AL-1'));
    const tagged = seed('alpha', task('AL-2', ['epic:AL-1', 'dep:AL-404']));
    const before = readFileSync(tagged, 'utf8');
    const out = path.join(dir, 'plan.jsonl');
    const unresolved = path.join(dir, 'unresolved.md');

    const run = spawnSync(
      'node',
      [SCRIPT, '--root', path.join(dir, 'root'), '--out', out, '--unresolved', unresolved],
      { encoding: 'utf8' },
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ tasks_touched: 1, unreadable_task_files: [] });
    expect(readFileSync(out, 'utf8')).toBe(
      '{"slug":"alpha","id":"AL-2","ops":[{"set_parent":"AL-1"}]}\n',
    );
    expect(readFileSync(unresolved, 'utf8')).toContain('dep:AL-404 | unknown-id');
    expect(readFileSync(tagged, 'utf8')).toBe(before);
  });

  it('refuses to run without a root or an output path', () => {
    const run = spawnSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ACTIVE_ROOT: '' },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Usage');
  });
});
