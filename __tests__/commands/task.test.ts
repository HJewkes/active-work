import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import taskAdd from '../../src/commands/task-add.js';
import taskDone from '../../src/commands/task-done.js';
import taskList from '../../src/commands/task-list.js';
import taskEdit from '../../src/commands/task-edit.js';
import taskReorder from '../../src/commands/task-reorder.js';
import taskDelete from '../../src/commands/task-delete.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { NotFoundError, UsageError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

const SLUG = 'sample-initiative';

describe('task.add', () => {
  it('assigns next sequential ID and auto priority', async () => {
    await withTempActiveRoot(async (root) => {
      const created = await taskAdd.run(
        { slug: SLUG, title: 'Third sample task' },
        ctx(root),
      );
      expect(created.id).toBe('SI-3');
      // Existing priorities are 1 and 2, so next is 3.
      expect(created.priority).toBe(3);
      expect(created.status).toBe('open');
      expect(created.done_at).toBeNull();

      const onDisk = await fs.readFile(
        path.join(root, SLUG, 'tasks', 'SI-3.yml'),
        'utf8',
      );
      expect(onDisk).toContain('id: SI-3');
    });
  });

  it('respects an explicit priority and stores tags/notes', async () => {
    await withTempActiveRoot(async (root) => {
      const created = await taskAdd.run(
        {
          slug: SLUG,
          title: 'Specific priority',
          priority: 7,
          severity: 'low',
          tags: ['alpha', 'beta'],
          notes: 'remember to test',
        },
        ctx(root),
      );
      expect(created.priority).toBe(7);
      expect(created.severity).toBe('low');
      expect(created.tags).toEqual(['alpha', 'beta']);
      expect(created.notes).toBe('remember to test');
    });
  });

  it('throws NotFoundError when the initiative does not exist', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        taskAdd.run(
          { slug: 'no-such-initiative', title: 'irrelevant' },
          ctx(root),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('task.done', () => {
  it('flips status and sets done_at to today', async () => {
    await withTempActiveRoot(async (root) => {
      const updated = await taskDone.run({ slug: SLUG, id: 'SI-1' }, ctx(root));
      expect(updated.status).toBe('done');
      expect(updated.done_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(updated.updated).toBe(updated.done_at);
    });
  });

  it('throws NotFoundError for a missing task', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        taskDone.run({ slug: SLUG, id: 'SI-99' }, ctx(root)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('task.list', () => {
  it('defaults to open status only', async () => {
    await withTempActiveRoot(async (root) => {
      const { tasks } = await taskList.run({ slug: SLUG }, ctx(root));
      expect(tasks.map((t) => t.id)).toEqual(['SI-1']);
    });
  });

  it('returns done tasks when status=done', async () => {
    await withTempActiveRoot(async (root) => {
      const { tasks } = await taskList.run(
        { slug: SLUG, status: 'done' },
        ctx(root),
      );
      expect(tasks.map((t) => t.id)).toEqual(['SI-2']);
    });
  });

  it('returns everything when status=all', async () => {
    await withTempActiveRoot(async (root) => {
      const { tasks } = await taskList.run(
        { slug: SLUG, status: 'all' },
        ctx(root),
      );
      expect(tasks.map((t) => t.id).sort()).toEqual(['SI-1', 'SI-2']);
    });
  });

  it('sorts by priority ascending', async () => {
    await withTempActiveRoot(async (root) => {
      // Add a task at priority 5; SI-1 has priority 1, SI-2 has priority 2.
      await taskAdd.run(
        { slug: SLUG, title: 'Later', priority: 5 },
        ctx(root),
      );
      const { tasks } = await taskList.run(
        { slug: SLUG, status: 'all' },
        ctx(root),
      );
      const priorities = tasks.map((t) => t.priority);
      const sorted = [...priorities].sort((a, b) => a - b);
      expect(priorities).toEqual(sorted);
    });
  });

  it('scans all initiatives when all_initiatives is true', async () => {
    await withTempActiveRoot(async (root) => {
      // Scaffold a second initiative directory by hand.
      const otherDir = path.join(root, 'other-initiative');
      await fs.mkdir(path.join(otherDir, 'tasks'), { recursive: true });
      await fs.writeFile(
        path.join(otherDir, 'brief.md'),
        `---\nschema_version: 1\ntitle: Other\nupdated: 2026-05-10\nstate: backburner\ntask_prefix: OI\n---\n\nother\n`,
      );
      await fs.writeFile(
        path.join(otherDir, 'tasks', 'OI-1.yml'),
        `id: OI-1\ntitle: Other open\npriority: 1\nstatus: open\ncreated: 2026-05-01\nupdated: 2026-05-01\ndone_at: null\n`,
      );
      const { tasks } = await taskList.run(
        { all_initiatives: true },
        ctx(root),
      );
      const ids = tasks.map((t) => `${t.slug}:${t.id}`).sort();
      expect(ids).toEqual([
        'other-initiative:OI-1',
        'sample-initiative:SI-1',
      ]);
    });
  });

  it('filters by tag', async () => {
    await withTempActiveRoot(async (root) => {
      const { tasks } = await taskList.run(
        { slug: SLUG, tag: 'example' },
        ctx(root),
      );
      expect(tasks.map((t) => t.id)).toEqual(['SI-1']);

      const empty = await taskList.run(
        { slug: SLUG, tag: 'missing' },
        ctx(root),
      );
      expect(empty.tasks).toEqual([]);
    });
  });

  it('filters by severity', async () => {
    await withTempActiveRoot(async (root) => {
      const high = await taskList.run(
        { slug: SLUG, severity: 'high' },
        ctx(root),
      );
      expect(high.tasks.map((t) => t.id)).toEqual(['SI-1']);

      const low = await taskList.run(
        { slug: SLUG, severity: 'low' },
        ctx(root),
      );
      expect(low.tasks).toEqual([]);
    });
  });

  it('throws when neither slug nor all_initiatives is provided', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(taskList.run({}, ctx(root))).rejects.toBeInstanceOf(
        UsageError,
      );
    });
  });
});

describe('task.edit', () => {
  it('edits each editable field and stamps updated', async () => {
    await withTempActiveRoot(async (root) => {
      const t1 = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'title', value: 'New title' },
        ctx(root),
      );
      expect(t1.title).toBe('New title');
      expect(t1.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const t2 = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'priority', value: 9 },
        ctx(root),
      );
      expect(t2.priority).toBe(9);

      const t3 = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'severity', value: 'critical' },
        ctx(root),
      );
      expect(t3.severity).toBe('critical');

      const t4 = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'estimate', value: 4 },
        ctx(root),
      );
      expect(t4.estimate).toBe(4);

      const t5 = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'done_when', value: 'ship it' },
        ctx(root),
      );
      expect(t5.done_when).toBe('ship it');

      const t6 = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'tags', value: ['x', 'y'] },
        ctx(root),
      );
      expect(t6.tags).toEqual(['x', 'y']);

      const t7 = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'notes', value: 'updated note' },
        ctx(root),
      );
      expect(t7.notes).toBe('updated note');

      const t8 = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'status', value: 'done' },
        ctx(root),
      );
      expect(t8.status).toBe('done');
      expect(t8.done_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it('rejects unknown fields', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        taskEdit.run(
          { slug: SLUG, id: 'SI-1', field: 'id', value: 'SI-99' },
          ctx(root),
        ),
      ).rejects.toBeInstanceOf(UsageError);
      await expect(
        taskEdit.run(
          { slug: SLUG, id: 'SI-1', field: 'created', value: '2026-01-01' },
          ctx(root),
        ),
      ).rejects.toBeInstanceOf(UsageError);
    });
  });

  it('throws NotFoundError for a missing task', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        taskEdit.run(
          { slug: SLUG, id: 'SI-99', field: 'title', value: 'x' },
          ctx(root),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('task.reorder', () => {
  it('shifts other tasks down when moving a task up', async () => {
    await withTempActiveRoot(async (root) => {
      // Add SI-3 with priority 3 so we have priorities 1, 2, 3.
      await taskAdd.run({ slug: SLUG, title: 'third' }, ctx(root));
      // Move SI-3 (priority 3) to priority 1; SI-1 and SI-2 should shift +1.
      const res = await taskReorder.run(
        { slug: SLUG, id: 'SI-3', new_priority: 1 },
        ctx(root),
      );
      expect(res.from).toBe(3);
      expect(res.to).toBe(1);
      const shiftedIds = res.shifted.map((s) => s.id).sort();
      expect(shiftedIds).toEqual(['SI-1', 'SI-2']);
      for (const s of res.shifted) {
        expect(s.to).toBe(s.from + 1);
      }

      // Verify on disk.
      const { tasks } = await taskList.run(
        { slug: SLUG, status: 'all' },
        ctx(root),
      );
      const byId = new Map(tasks.map((t) => [t.id, t.priority]));
      expect(byId.get('SI-3')).toBe(1);
      expect(byId.get('SI-1')).toBe(2);
      expect(byId.get('SI-2')).toBe(3);
    });
  });

  it('is a no-op when target is already at the new priority', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await taskReorder.run(
        { slug: SLUG, id: 'SI-1', new_priority: 1 },
        ctx(root),
      );
      expect(res.from).toBe(1);
      expect(res.to).toBe(1);
      expect(res.shifted).toEqual([]);

      const { tasks } = await taskList.run(
        { slug: SLUG, status: 'all' },
        ctx(root),
      );
      const byId = new Map(tasks.map((t) => [t.id, t.priority]));
      expect(byId.get('SI-1')).toBe(1);
      expect(byId.get('SI-2')).toBe(2);
    });
  });

  it('throws NotFoundError when the task is missing', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        taskReorder.run(
          { slug: SLUG, id: 'SI-99', new_priority: 1 },
          ctx(root),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('task.delete', () => {
  it('removes the task file', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await taskDelete.run(
        { slug: SLUG, id: 'SI-1' },
        ctx(root),
      );
      expect(res).toEqual({ id: 'SI-1', deleted: true });
      await expect(
        fs.access(path.join(root, SLUG, 'tasks', 'SI-1.yml')),
      ).rejects.toThrow();
    });
  });

  it('throws NotFoundError when the task is missing', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        taskDelete.run({ slug: SLUG, id: 'SI-99' }, ctx(root)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
