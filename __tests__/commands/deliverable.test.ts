import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import deliverableAdd from '../../src/commands/deliverable-add.js';
import deliverableList from '../../src/commands/deliverable-list.js';
import deliverableSet from '../../src/commands/deliverable-set.js';
import deliverableShip from '../../src/commands/deliverable-ship.js';
import taskAdd from '../../src/commands/task-add.js';
import taskEdit from '../../src/commands/task-edit.js';
import { NotFoundError, UsageError, ValidationError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function recordPath(root: string, id: string): string {
  return path.join(root, 'titan-platform', 'deliverables', `${id}.yml`);
}

function add(root: string, id: string, extra: Record<string, unknown> = {}) {
  const args = { id, title: `Deliverable ${id}`, done_when: 'It ships', owner_seat: 'seat-a' };
  return deliverableAdd.run({ ...args, ...extra }, ctx(root));
}

async function joinTask(root: string, id: string, deliverable: string): Promise<void> {
  await taskEdit.run({ slug: SLUG, id, deliverable: [deliverable] }, ctx(root));
}

async function seedOtherInitiativeTask(root: string, deliverable: string): Promise<void> {
  const dir = path.join(root, 'other-initiative', 'tasks');
  await fs.mkdir(dir, { recursive: true });
  const task = {
    id: 'OI-1',
    title: 'Elsewhere',
    priority: 1,
    status: 'done',
    deliverables: [deliverable],
    created: '2026-01-01',
    updated: '2026-01-02',
    done_at: '2026-01-02',
  };
  await fs.writeFile(path.join(dir, 'OI-1.yml'), YAML.stringify(task));
}

describe('deliverable add', () => {
  it('writes the record under titan-platform/deliverables with status planned', async () => {
    await withTempActiveRoot(async (root) => {
      const created = await add(root, 'console-v1', { tags: ['ui'] });

      const onDisk = YAML.parse(await fs.readFile(recordPath(root, 'console-v1'), 'utf8'));
      expect(onDisk).toEqual(created);
      expect(created.status).toBe('planned');
      expect(created.shipped_at).toBeNull();
      expect(created.target).toBeNull();
      expect(created.tags).toEqual(['ui']);
    });
  });

  it('refuses an id that already exists, in any case', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'console-v1');

      await expect(add(root, 'console-v1')).rejects.toBeInstanceOf(UsageError);
      await expect(add(root, 'Console-V1')).rejects.toThrow(/already exists: console-v1/);
    });
  });

  it('rejects a target that is not a date and writes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(add(root, 'M1', { target: 'soon' })).rejects.toBeInstanceOf(ValidationError);
      await expect(fs.access(recordPath(root, 'M1'))).rejects.toThrow();
    });
  });
});

describe('deliverable set', () => {
  it('updates status, target and owner seat on one record only', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1');
      await add(root, 'M2');

      const updated = await deliverableSet.run(
        { id: 'M1', status: 'active', target: '2026-12-01', owner_seat: 'seat-b' },
        ctx(root),
      );

      expect(updated).toMatchObject({
        status: 'active',
        target: '2026-12-01',
        owner_seat: 'seat-b',
      });
      const other = YAML.parse(await fs.readFile(recordPath(root, 'M2'), 'utf8'));
      expect(other).toMatchObject({ status: 'planned', target: null, owner_seat: 'seat-a' });
    });
  });

  it('clears the target with none and reopens a shipped deliverable without shipped_at', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1', { target: '2026-12-01' });
      await deliverableShip.run({ id: 'M1' }, ctx(root));

      const reopened = await deliverableSet.run(
        { id: 'M1', status: 'active', target: 'none' },
        ctx(root),
      );

      expect(reopened).toMatchObject({ status: 'active', target: null, shipped_at: null });
    });
  });

  it('fails on an unknown id and on an empty change', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        deliverableSet.run({ id: 'M9', status: 'active' }, ctx(root)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(deliverableSet.run({ id: 'M9' }, ctx(root))).rejects.toBeInstanceOf(UsageError);
    });
  });
});

describe('deliverable list', () => {
  it('ANDs repeated tags and filters by status', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'A', { tags: ['ui', 'web'] });
      await add(root, 'B', { tags: ['ui'], status: 'active' });
      await add(root, 'C', { tags: ['web'] });

      const both = await deliverableList.run({ tag: ['ui', 'web'] }, ctx(root));
      const activeUi = await deliverableList.run({ tag: ['ui'], status: 'active' }, ctx(root));

      expect(both.map((row) => row.id)).toEqual(['A']);
      expect(activeUi.map((row) => row.id)).toEqual(['B']);
    });
  });

  it('counts open and done joined tasks across every initiative', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1');
      await add(root, 'M2');
      await joinTask(root, 'SI-1', 'M1');
      await seedOtherInitiativeTask(root, 'M1');

      const rows = await deliverableList.run({}, ctx(root));

      expect(rows.find((row) => row.id === 'M1')?.tasks).toEqual({ open: 1, done: 1 });
      expect(rows.find((row) => row.id === 'M2')?.tasks).toEqual({ open: 0, done: 0 });
    });
  });

  it('returns an empty list when the registry directory does not exist', async () => {
    await withTempActiveRoot(async (root) => {
      expect(await deliverableList.run({}, ctx(root))).toEqual([]);
    });
  });
});

describe('deliverable ship', () => {
  it('refuses while a joined task is open, naming it, and writes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1');
      await joinTask(root, 'SI-1', 'M1');
      await seedOtherInitiativeTask(root, 'M1');

      await expect(deliverableShip.run({ id: 'M1' }, ctx(root))).rejects.toThrow(
        /Refusing to ship M1: 1 joined task\(s\) still open: SI-1\./,
      );
      const onDisk = YAML.parse(await fs.readFile(recordPath(root, 'M1'), 'utf8'));
      expect(onDisk.status).toBe('planned');
    });
  });

  it('ships with --force despite open tasks, setting shipped_at', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1');
      await joinTask(root, 'SI-1', 'M1');

      const shipped = await deliverableShip.run({ id: 'M1', force: true }, ctx(root));

      expect(shipped.status).toBe('shipped');
      expect(shipped.shipped_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it('ships when every joined task is done', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1');
      await seedOtherInitiativeTask(root, 'M1');

      const shipped = await deliverableShip.run({ id: 'M1' }, ctx(root));

      expect(shipped.status).toBe('shipped');
    });
  });
});

describe('task --deliverable', () => {
  it('task add stores known deliverable ids and rejects an unknown one', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1');

      const created = await taskAdd.run(
        { slug: SLUG, title: 'Joined', deliverable: ['M1'] },
        ctx(root),
      );
      const refused = taskAdd.run(
        { slug: SLUG, title: 'Orphan', deliverable: ['M1', 'M9'] },
        ctx(root),
      );

      expect(created.deliverables).toEqual(['M1']);
      await expect(refused).rejects.toThrow(/Unknown deliverable id: M9/);
      await expect(fs.access(path.join(root, SLUG, 'tasks', 'SI-4.yml'))).rejects.toThrow();
    });
  });

  it('task edit adds a deliverable, keeping the others, and rejects an unknown one', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1');
      await add(root, 'M2');
      await joinTask(root, 'SI-1', 'M1');

      const edited = await taskEdit.run({ slug: SLUG, id: 'SI-1', deliverable: ['M2'] }, ctx(root));
      const refused = taskEdit.run({ slug: SLUG, id: 'SI-1', deliverable: ['M9'] }, ctx(root));

      expect(edited.deliverables).toEqual(['M1', 'M2']);
      await expect(refused).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('task edit reports an already-joined deliverable without rewriting the task', async () => {
    await withTempActiveRoot(async (root) => {
      await add(root, 'M1');
      await joinTask(root, 'SI-1', 'M1');
      const context = ctx(root);

      const line = await taskEdit.run(
        { slug: SLUG, id: 'SI-1', deliverable: ['M1'], quiet: true },
        { ...context, format: 'human' },
      );

      expect(line).toBe('SI-1 unchanged\n');
      expect(context.warnings).toEqual(['Deliverable already present, nothing added: M1']);
    });
  });
});
