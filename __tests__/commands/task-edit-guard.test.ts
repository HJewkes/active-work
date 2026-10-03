import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import taskEdit from '../../src/commands/task-edit.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { UsageError } from '../../src/errors.js';
import type { Task } from '../../src/schemas/task.js';

const SLUG = 'sample-initiative';
const ID = 'SI-7';
const NOTES = 'Line one\nLine two\n';

function taskFile(root: string): string {
  return path.join(root, SLUG, 'tasks', `${ID}.yml`);
}

async function seedTask(root: string, overrides: Partial<Task> = {}): Promise<void> {
  const task = {
    id: ID,
    title: 'Synthetic task',
    priority: 7,
    done_when: 'The guard works',
    status: 'open',
    tags: ['alpha', 'beta'],
    notes: NOTES,
    created: '2026-01-02',
    updated: '2026-01-03',
    done_at: null,
    ...overrides,
  };
  await fs.writeFile(taskFile(root), YAML.stringify(task));
}

async function readTask(root: string): Promise<Task> {
  return YAML.parse(await fs.readFile(taskFile(root), 'utf8')) as Task;
}

function edit(root: string, args: Record<string, unknown>): Promise<Task> {
  return taskEdit.run(
    { slug: SLUG, id: ID, ...args },
    { activeRoot: root, warnings: [], format: 'json' },
  );
}

describe('task.edit field-form guard', () => {
  it('refuses notes shorter than the current notes and keeps them', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      const run = edit(root, { field: 'notes', value: 'short' });
      await expect(run).rejects.toBeInstanceOf(UsageError);
      await expect(run).rejects.toThrow(/--append.*--force/);
      expect((await readTask(root)).notes).toBe(NOTES);
    });
  });

  it('allows notes of equal or longer length', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      await edit(root, { field: 'notes', value: `${NOTES}Line three\n` });
      expect((await readTask(root)).notes).toBe(`${NOTES}Line three\n`);
    });
  });

  it('refuses tags that drop an existing tag', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      const run = edit(root, { field: 'tags', value: 'alpha,gamma' });
      await expect(run).rejects.toThrow(/--add-tag.*--remove-tag.*--force/);
      expect((await readTask(root)).tags).toEqual(['alpha', 'beta']);
    });
  });

  it('allows tags that add to the existing ones', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      await edit(root, { field: 'tags', value: 'alpha,beta,gamma' });
      expect((await readTask(root)).tags).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  it('refuses to replace a non-empty done_when', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      await expect(edit(root, { field: 'done_when', value: 'Other' })).rejects.toThrow(/--force/);
      expect((await readTask(root)).done_when).toBe('The guard works');
    });
  });

  it('fills an empty done_when without --force', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, { done_when: undefined });
      await edit(root, { field: 'done_when', value: 'Filled in' });
      expect((await readTask(root)).done_when).toBe('Filled in');
    });
  });

  it('lets --force replace notes, tags and done_when', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      await edit(root, { field: 'notes', value: 'x', force: true });
      await edit(root, { field: 'tags', value: 'gamma', force: true });
      await edit(root, { field: 'done_when', value: 'Other', force: true });
      const after = await readTask(root);
      expect(after.notes).toBe('x');
      expect(after.tags).toEqual(['gamma']);
      expect(after.done_when).toBe('Other');
    });
  });

  it('still removes one tag through --remove-tag', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      await edit(root, { remove_tag: 'alpha' });
      expect((await readTask(root)).tags).toEqual(['beta']);
    });
  });
});
