import { describe, it, expect } from 'vitest';
import taskShow from '../../src/commands/task-show.js';
import taskEdit from '../../src/commands/task-edit.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { NotFoundError, UsageError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';

function ctx(activeRoot: string, format: 'human' | 'json' = 'json'): CommandContext {
  return { activeRoot, warnings: [], format };
}

const SLUG = 'sample-initiative';

describe('task.show', () => {
  it('returns the full task as JSON for <slug> <id>', async () => {
    await withTempActiveRoot(async (root) => {
      const task = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root));
      expect(task).toMatchObject({
        id: 'SI-1',
        title: 'First sample task',
        status: 'open',
        severity: 'high',
        estimate: 3,
        created: '2026-05-09',
        done_at: null,
      });
    });
  });

  it('accepts the <slug>/<id> form', async () => {
    await withTempActiveRoot(async (root) => {
      const task = await taskShow.run({ slug: `${SLUG}/SI-2` }, ctx(root));
      expect(task).toMatchObject({ id: 'SI-2', status: 'done' });
    });
  });

  it('prints a compact human form with the last five note lines', async () => {
    await withTempActiveRoot(async (root) => {
      const notes = Array.from({ length: 7 }, (_, i) => `note ${i + 1}`).join('\n\n');
      await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'notes', value: notes, force: true },
        ctx(root),
      );

      const out = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root, 'human'));

      expect(out).toBe(
        [
          'id: SI-1',
          'title: First sample task',
          'status: open',
          'severity: high',
          'estimate: 3',
          'tags: example',
          'done_when: It compiles',
          'notes (last 5 lines):',
          '  note 3',
          '  note 4',
          '  note 5',
          '  note 6',
          '  note 7',
          '',
        ].join('\n'),
      );
    });
  });

  it('omits absent optional fields from the human form', async () => {
    await withTempActiveRoot(async (root) => {
      const out = await taskShow.run({ slug: SLUG, id: 'SI-2' }, ctx(root, 'human'));
      expect(out).toBe('id: SI-2\ntitle: Second sample task, already done\nstatus: done\n');
    });
  });

  it('prints only the requested --fields as key: value lines', async () => {
    await withTempActiveRoot(async (root) => {
      const out = await taskShow.run(
        { slug: SLUG, id: 'SI-1', fields: 'id,status,done_when' },
        ctx(root, 'human'),
      );
      expect(out).toBe('id: SI-1\nstatus: open\ndone_when: It compiles\n');
    });
  });

  it('returns only the requested --fields as JSON, with null for absent keys', async () => {
    await withTempActiveRoot(async (root) => {
      const picked = await taskShow.run(
        { slug: SLUG, id: 'SI-2', fields: 'id,status,notes' },
        ctx(root),
      );
      expect(picked).toEqual({ id: 'SI-2', status: 'done', notes: null });
    });
  });

  it('rejects an unknown --fields key', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        taskShow.run({ slug: SLUG, id: 'SI-1', fields: 'id,flavour' }, ctx(root)),
      ).rejects.toThrow(/Unknown task field\(s\): flavour/);
    });
  });

  it('fails with "task <id> not found in <slug>" for an unknown id', async () => {
    await withTempActiveRoot(async (root) => {
      const run = taskShow.run({ slug: SLUG, id: 'SI-99' }, ctx(root));
      await expect(run).rejects.toBeInstanceOf(NotFoundError);
      await expect(run).rejects.toThrow('task SI-99 not found in sample-initiative');
    });
  });

  it('treats an id that is not a task id as not found rather than a path', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(taskShow.run({ slug: SLUG, id: '../brief' }, ctx(root))).rejects.toThrow(
        'task ../brief not found in sample-initiative',
      );
    });
  });

  it('gives the existing "Initiative not found" error for an unknown slug', async () => {
    await withTempActiveRoot(async (root) => {
      const run = taskShow.run({ slug: 'no-such-initiative', id: 'SI-1' }, ctx(root));
      await expect(run).rejects.toBeInstanceOf(NotFoundError);
      await expect(run).rejects.toThrow('Initiative not found: no-such-initiative');
    });
  });

  it('requires an id when the slug carries no /<id>', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(taskShow.run({ slug: SLUG }, ctx(root))).rejects.toBeInstanceOf(UsageError);
    });
  });
});
