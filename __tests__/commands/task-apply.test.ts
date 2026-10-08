import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { invokeCommand } from '@titan-design/registry';
import taskApply from '../../src/commands/task-apply.js';
import '../../src/commands/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { today } from '../../src/utils/today.js';
import type { CommandContext } from '../../src/registry/index.js';
import type { Task } from '../../src/schemas/task.js';

const lockTargets = vi.hoisted(() => [] as string[]);
const writtenFiles = vi.hoisted(() => [] as string[]);

vi.mock('../../src/utils/yaml-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/yaml-io.js')>();
  return {
    ...actual,
    writeYaml: (...args: Parameters<typeof actual.writeYaml>) => {
      writtenFiles.push(args[0]);
      return actual.writeYaml(...args);
    },
  };
});

vi.mock('../../src/utils/fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/fs-atomic.js')>();
  return {
    ...actual,
    withFileLock: <T>(target: string, fn: () => Promise<T>) => {
      lockTargets.push(target);
      return actual.withFileLock(target, fn);
    },
  };
});

const SLUG = 'sample-initiative';
const OTHER = 'other-initiative';

interface Summary {
  counts: Record<'applied' | 'unchanged' | 'missing' | 'failed', number>;
  results: { slug: string; id: string; result: string; changes: string[]; error?: string }[];
}

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', cwd: activeRoot };
}

function taskFile(root: string, id: string, slug = SLUG): string {
  return path.join(root, slug, 'tasks', `${id}.yml`);
}

async function seedTask(root: string, id: string, slug = SLUG): Promise<string> {
  const task = {
    id,
    title: 'Synthetic task',
    priority: 3,
    status: 'open',
    tags: ['alpha'],
    notes: 'First line\n',
    created: '2026-01-02',
    updated: '2026-01-03',
    done_at: null,
  };
  await fs.mkdir(path.dirname(taskFile(root, id, slug)), { recursive: true });
  await fs.writeFile(taskFile(root, id, slug), YAML.stringify(task));
  return fs.readFile(taskFile(root, id, slug), 'utf8');
}

async function readTask(root: string, id: string, slug = SLUG): Promise<Task> {
  return YAML.parse(await fs.readFile(taskFile(root, id, slug), 'utf8')) as Task;
}

async function writePlan(root: string, lines: unknown[]): Promise<string> {
  const file = path.join(root, 'plan.jsonl');
  await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

async function apply(root: string, plan: string, flags: Record<string, unknown> = {}) {
  return invokeCommand(taskApply, { plan, ...flags }, ctx(root));
}

function summaryOf(envelope: { ok: boolean }): Summary {
  return (envelope as { ok: true; data: Summary }).data;
}

const FULL_LINE = {
  slug: SLUG,
  id: 'SI-1',
  note: 'extra keys are ignored',
  ops: [{ add_tag: 'spine:M1' }, { append: 'Sweep line' }, { done: true }],
};

describe('task.apply', () => {
  it('applies add_tag, append and done to one task in a single write', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, 'SI-1');
      const plan = await writePlan(root, [FULL_LINE]);
      writtenFiles.length = 0;

      const out = await apply(root, plan);

      expect(writtenFiles).toEqual([taskFile(root, 'SI-1')]);
      const task = await readTask(root, 'SI-1');
      expect(task.tags).toEqual(['alpha', 'spine:M1']);
      expect(task.notes).toBe('First line\nSweep line\n');
      expect(task).toMatchObject({ status: 'done', done_at: today(), updated: today() });
      expect(summaryOf(out.envelope).counts).toEqual({
        applied: 1,
        unchanged: 0,
        missing: 0,
        failed: 0,
      });
    });
  });

  it('leaves the file byte-identical on a second run and reports it unchanged', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, 'SI-1');
      const plan = await writePlan(root, [FULL_LINE]);
      await apply(root, plan);
      const afterFirst = await fs.readFile(taskFile(root, 'SI-1'), 'utf8');
      writtenFiles.length = 0;

      const out = await apply(root, plan);

      expect(writtenFiles).toEqual([]);
      expect(await fs.readFile(taskFile(root, 'SI-1'), 'utf8')).toBe(afterFirst);
      expect(summaryOf(out.envelope).results).toEqual([
        { slug: SLUG, id: 'SI-1', result: 'unchanged', changes: [] },
      ]);
    });
  });

  it('reports a missing task and still applies the rest of the plan', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, 'SI-1');
      const plan = await writePlan(root, [
        { slug: SLUG, id: 'SI-404', ops: [{ done: true }] },
        { slug: SLUG, id: 'SI-1', ops: [{ add_tag: 'beta' }] },
      ]);

      const out = await apply(root, plan);

      expect(out.exitCode).toBe(0);
      expect(summaryOf(out.envelope).results.map((r) => r.result)).toEqual(['missing', 'applied']);
      expect((await readTask(root, 'SI-1')).tags).toEqual(['alpha', 'beta']);
    });
  });

  it('fails a line with an unknown op, exits non-zero and applies the other lines', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, 'SI-1');
      await seedTask(root, 'SI-2');
      const plan = await writePlan(root, [
        { slug: SLUG, id: 'SI-1', ops: [{ frobnicate: 'x' }] },
        { slug: SLUG, id: 'SI-2', ops: [{ append: 'Kept line' }] },
      ]);
      const report = path.join(root, 'report.jsonl');

      const out = await apply(root, plan, { report });

      expect(out.exitCode).not.toBe(0);
      const lines = (await fs.readFile(report, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines[0]).toMatchObject({
        id: 'SI-1',
        result: 'failed',
        error: 'Unknown op: frobnicate',
      });
      expect(lines[1]).toMatchObject({ id: 'SI-2', result: 'applied' });
      expect((await readTask(root, 'SI-2')).notes).toBe('First line\nKept line\n');
    });
  });

  it('writes no task file on --dry-run but still reports what would change', async () => {
    await withTempActiveRoot(async (root) => {
      const before = await seedTask(root, 'SI-1');
      const plan = await writePlan(root, [FULL_LINE]);

      const out = await apply(root, plan, { dry_run: true });

      expect(await fs.readFile(taskFile(root, 'SI-1'), 'utf8')).toBe(before);
      expect(summaryOf(out.envelope).counts.applied).toBe(1);
    });
  });

  it('takes one lock per slug and applies both initiatives in one plan', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, 'SI-1');
      await seedTask(root, 'OI-1', OTHER);
      const plan = await writePlan(root, [
        { slug: SLUG, id: 'SI-1', ops: [{ add_tag: 'beta' }] },
        { slug: OTHER, id: 'OI-1', ops: [{ add_tag: 'beta' }] },
      ]);
      lockTargets.length = 0;

      await apply(root, plan);

      expect(lockTargets).toEqual([
        path.join(root, SLUG, '.lock'),
        path.join(root, OTHER, '.lock'),
      ]);
      expect((await readTask(root, 'SI-1')).tags).toEqual(['alpha', 'beta']);
      expect((await readTask(root, 'OI-1', OTHER)).tags).toEqual(['alpha', 'beta']);
    });
  });
});
