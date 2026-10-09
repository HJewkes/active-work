import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import taskAdd from '../../src/commands/task-add.js';
import taskEdit from '../../src/commands/task-edit.js';
import { ValidationError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import type { Task } from '../../src/schemas/task.js';
import { buildEdgeIndex, edgeWriteErrors } from '../../src/tasks/edge-index.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

// Two initiatives share the H prefix on purpose: ids resolve by file, not by prefix.
const SEED: Record<string, { prefix: string; tasks: Partial<Task>[] }> = {
  alpha: {
    prefix: 'H',
    tasks: [
      { id: 'H-1' },
      { id: 'H-2', dep: ['H-1'] },
      { id: 'H-5' },
      { id: 'H-6', tags: ['dep:H-1'] },
    ],
  },
  beta: { prefix: 'H', tasks: [{ id: 'H-5', dep: ['H-404'] }, { id: 'H-10' }] },
  gamma: { prefix: 'G', tasks: [{ id: 'G-1', dep: ['H-2'] }] },
};

function fullTask(partial: Partial<Task>): Task {
  return {
    id: 'X-1',
    title: 'Synthetic task',
    priority: 1,
    status: 'open',
    created: '2026-01-02',
    updated: '2026-01-02',
    done_at: null,
    ...partial,
  };
}

async function seed(root: string): Promise<void> {
  for (const [slug, { prefix, tasks }] of Object.entries(SEED)) {
    const dir = path.join(root, slug, 'tasks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(root, slug, 'brief.md'), `---\ntask_prefix: ${prefix}\n---\n`);
    for (const task of tasks) {
      await fs.writeFile(path.join(dir, `${task.id}.yml`), YAML.stringify(fullTask(task)));
    }
  }
}

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

async function readTask(root: string, slug: string, id: string): Promise<Task> {
  return YAML.parse(await fs.readFile(path.join(root, slug, 'tasks', `${id}.yml`), 'utf8')) as Task;
}

async function taskFiles(root: string, slug: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, slug, 'tasks'))).sort();
}

async function inSeededRoot(fn: (root: string) => Promise<void>): Promise<void> {
  await withEmptyActiveRoot(async (root) => {
    await seed(root);
    await fn(root);
  });
}

function add(root: string, flags: Record<string, unknown>): Promise<unknown> {
  return taskAdd.run({ slug: 'alpha', title: 'New task', ...flags }, ctx(root));
}

function edit(root: string, id: string, flags: Record<string, unknown>): Promise<unknown> {
  return taskEdit.run({ slug: 'alpha', id, ...flags }, ctx(root));
}

describe('task add with edges', () => {
  it('writes parent and dep as fields when every id resolves', async () => {
    await inSeededRoot(async (root) => {
      await add(root, { parent: 'H-1', dep: ['G-1', 'H-10'] });

      const added = await readTask(root, 'alpha', 'H-7');
      expect(added.parent).toBe('H-1');
      expect(added.dep).toEqual(['G-1', 'H-10']);
    });
  });

  it.each([
    ['an unknown dep', { dep: ['H-404'] }, ['H-404']],
    ['a parent in another initiative', { parent: 'G-1' }, ['G-1', 'gamma']],
    ['an id filed in two initiatives', { dep: ['H-5'] }, ['H-5', 'alpha', 'beta']],
  ])('refuses %s, names the ids and writes nothing', async (_case, flags, named) => {
    await inSeededRoot(async (root) => {
      const before = await taskFiles(root, 'alpha');

      const failure = add(root, flags);

      await expect(failure).rejects.toBeInstanceOf(ValidationError);
      const message = await failure.catch((err: Error) => err.message);
      for (const id of named) expect(message).toContain(id);
      expect(await taskFiles(root, 'alpha')).toEqual(before);
    });
  });
});

describe('task edit with edges', () => {
  it('refuses a dep that closes a cycle across initiatives and leaves the file alone', async () => {
    await inSeededRoot(async (root) => {
      const file = path.join(root, 'alpha', 'tasks', 'H-1.yml');
      const before = await fs.readFile(file, 'utf8');

      const failure = edit(root, 'H-1', { dep: ['G-1'] });

      await expect(failure).rejects.toBeInstanceOf(ValidationError);
      await expect(failure.catch((err: Error) => err.message)).resolves.toContain(
        'dep cycle: H-1 -> G-1 -> H-2 -> H-1',
      );
      expect(await fs.readFile(file, 'utf8')).toBe(before);
    });
  });

  it('refuses a parent that closes a parent cycle', async () => {
    await inSeededRoot(async (root) => {
      await edit(root, 'H-2', { parent: 'H-1' });

      await expect(edit(root, 'H-1', { parent: 'H-2' })).rejects.toThrow(
        'parent cycle: H-1 -> H-2 -> H-1',
      );
    });
  });

  it('refuses a parent in another initiative', async () => {
    await inSeededRoot(async (root) => {
      await expect(edit(root, 'H-1', { parent: 'H-10' })).rejects.toThrow(
        'parent H-10 is in beta, not alpha',
      );
    });
  });

  it('refuses a status outside the built-in set', async () => {
    await inSeededRoot(async (root) => {
      await expect(edit(root, 'H-1', { field: 'status', value: 'closed' })).rejects.toThrow(
        'Invalid value for status: closed (allowed: open, done)',
      );
    });
  });

  it.each([
    ['alpha', 'H-1', ['H-1']],
    ['beta', 'H-10', ['H-404', 'H-10']],
  ])('edits the %s copy of an id filed in two initiatives', async (slug, dep, expected) => {
    await inSeededRoot(async (root) => {
      await taskEdit.run({ slug, id: 'H-5', dep: [dep] }, ctx(root));

      expect((await readTask(root, slug, 'H-5')).dep).toEqual(expected);
    });
  });

  it('carries a tag-only dep into the dep field when adding another', async () => {
    await inSeededRoot(async (root) => {
      await edit(root, 'H-6', { dep: ['H-10'] });

      const task = await readTask(root, 'alpha', 'H-6');
      expect(task.dep).toEqual(['H-1', 'H-10']);
      expect(task.tags).toEqual(['dep:H-1']);
    });
  });

  it('removes a dep, even one whose target no longer exists', async () => {
    await inSeededRoot(async (root) => {
      await edit(root, 'H-2', { dep: ['H-10'] });
      await fs.rm(path.join(root, 'beta', 'tasks', 'H-10.yml'));

      await edit(root, 'H-2', { remove_dep: ['H-10'] });

      expect((await readTask(root, 'alpha', 'H-2')).dep).toEqual(['H-1']);
    });
  });
});

describe('edgeWriteErrors', () => {
  const index = buildEdgeIndex(
    new Map([['alpha', [fullTask({ id: 'H-1', dep: ['H-404'] }), fullTask({ id: 'H-2' })]]]),
  );

  it('does not block a write on a stale dep the write does not name', () => {
    expect(edgeWriteErrors(index, { slug: 'alpha', id: 'H-1', dep: ['H-404', 'H-2'] })).toEqual([]);
  });

  it('checks the edited copy of an id filed in two initiatives, not the other one', () => {
    const duplicated = buildEdgeIndex(
      new Map([
        ['alpha', [fullTask({ id: 'H-5' }), fullTask({ id: 'H-1' })]],
        ['beta', [fullTask({ id: 'H-5', dep: ['H-404'] }), fullTask({ id: 'H-10' })]],
      ]),
    );

    expect(
      edgeWriteErrors(duplicated, { slug: 'beta', id: 'H-5', dep: ['H-404', 'H-10'] }),
    ).toEqual([]);
    expect(edgeWriteErrors(duplicated, { slug: 'alpha', id: 'H-5', dep: ['H-1'] })).toEqual([]);
  });

  it('does not block a write on a cycle already on disk', () => {
    const cyclic = buildEdgeIndex(
      new Map([
        [
          'alpha',
          [
            fullTask({ id: 'H-1', dep: ['H-2'] }),
            fullTask({ id: 'H-2', dep: ['H-1'] }),
            fullTask({ id: 'H-3' }),
          ],
        ],
      ]),
    );

    expect(edgeWriteErrors(cyclic, { slug: 'alpha', id: 'H-1', dep: ['H-2', 'H-3'] })).toEqual([]);
  });

  it('names a stale dep the write adds', () => {
    expect(edgeWriteErrors(index, { slug: 'alpha', id: 'H-2', dep: ['H-404'] })).toEqual([
      'dep H-404 is not a known task id',
    ]);
  });
});
