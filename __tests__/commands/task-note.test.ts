import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import taskNote from '../../src/commands/task-note.js';
import { invokeTool } from '../../src/server/mcp.js';
import '../../src/commands/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/index.js';
import type { Task } from '../../src/schemas/task.js';

const SLUG = 'sample-initiative';
const ID = 'SI-7';

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function taskFile(root: string): string {
  return path.join(root, SLUG, 'tasks', `${ID}.yml`);
}

async function seedTask(root: string): Promise<void> {
  const task = {
    id: ID,
    title: 'Synthetic task',
    priority: 7,
    done_when: 'The note works',
    status: 'open',
    tags: ['alpha', 'beta'],
    notes: 'First line\n',
    created: '2026-01-02',
    updated: '2026-01-03',
    done_at: null,
  };
  await fs.writeFile(taskFile(root), YAML.stringify(task));
}

async function readTask(root: string): Promise<Task> {
  return YAML.parse(await fs.readFile(taskFile(root), 'utf8')) as Task;
}

function note(root: string, text: string, id = ID): Promise<Task> {
  return taskNote.run({ slug: SLUG, id, text }, ctx(root));
}

function withoutNotesAndStamp(task: Task): Partial<Task> {
  const { notes: _notes, updated: _updated, ...rest } = task;
  return rest;
}

describe('task.note', () => {
  it('appends one line and leaves every other field as it was', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      const before = await readTask(root);

      await note(root, 'Second line');

      const after = await readTask(root);
      expect(after.notes).toBe('First line\nSecond line\n');
      expect(withoutNotesAndStamp(after)).toEqual(withoutNotesAndStamp(before));
    });
  });

  it('appends a second line on a second call', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);

      await note(root, 'Second line');
      await note(root, 'Third line');

      expect((await readTask(root)).notes).toBe('First line\nSecond line\nThird line\n');
    });
  });

  it('refuses a field and value in place of note text and changes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      const before = await fs.readFile(taskFile(root), 'utf8');

      const out = await invokeTool('active__task__note', {
        slug: SLUG,
        id: ID,
        text: 'a note',
        field: 'status',
        value: 'done',
      });

      expect(out.envelope).toMatchObject({ ok: false });
      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(before);
    });
  });

  it('refuses extra flags that edit other fields', () => {
    const parsed = taskNote.args.safeParse({
      slug: SLUG,
      id: ID,
      text: 'a note',
      add_tag: 'x',
      force: true,
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses empty text and changes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      const before = await fs.readFile(taskFile(root), 'utf8');

      await expect(note(root, '   ')).rejects.toThrow(/non-empty/);

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(before);
    });
  });

  it('refuses an unknown task id', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);

      await expect(note(root, 'a note', 'SI-99')).rejects.toThrow(/Task not found: SI-99/);
    });
  });
});
