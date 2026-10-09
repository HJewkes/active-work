import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import categoryInit from '../../src/commands/category-init.js';
import categoryList from '../../src/commands/category-list.js';
import taskAdd from '../../src/commands/task-add.js';
import taskEdit from '../../src/commands/task-edit.js';
import { ValidationError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

const REGISTRY = {
  kind: ['epic', 'feature', 'bug'],
  status: [
    { id: 'open', closed: false, dispatchable: true },
    { id: 'done', closed: true, dispatchable: false },
    { id: 'wont-do', closed: true, dispatchable: false },
    { id: 'icebox', closed: false, dispatchable: false },
  ],
  cos: ['standard', 'fixed'],
  area: [
    { id: 'store', tier: 0, path: 'packages/store' },
    { id: 'console', tier: 'product' },
  ],
};

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function registryPath(root: string): string {
  return path.join(root, 'titan-platform', 'categories.yml');
}

async function writeRegistry(root: string, registry: unknown = REGISTRY): Promise<void> {
  await fs.mkdir(path.dirname(registryPath(root)), { recursive: true });
  await fs.writeFile(registryPath(root), YAML.stringify(registry));
}

async function readTask(root: string, id: string): Promise<Record<string, unknown>> {
  return YAML.parse(await fs.readFile(path.join(root, SLUG, 'tasks', `${id}.yml`), 'utf8'));
}

async function taskFiles(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, SLUG, 'tasks'))).sort();
}

function edit(root: string, args: Record<string, unknown>) {
  return taskEdit.run({ slug: SLUG, id: 'SI-1', ...args }, ctx(root));
}

describe('task add with categories', () => {
  it('writes kind, cos, area and due that the registry allows', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);
      const args = { kind: 'feature', cos: 'fixed', area: 'store', due: '2026-12-01' };

      const created = await taskAdd.run({ slug: SLUG, title: 'Categorised', ...args }, ctx(root));

      const onDisk = await readTask(root, (created as { id: string }).id);
      expect(onDisk).toMatchObject(args);
    });
  });

  it('refuses an unknown kind, naming the axis and allowed values, and writes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);
      const before = await taskFiles(root);

      const error: unknown = await taskAdd
        .run({ slug: SLUG, title: 'Bad', kind: 'chore' }, ctx(root))
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain(
        'Unknown kind: chore (allowed: epic, feature, bug)',
      );
      expect(await taskFiles(root)).toEqual(before);
    });
  });

  it('refuses cos fixed without a due date', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);

      await expect(
        taskAdd.run({ slug: SLUG, title: 'Bad', cos: 'fixed' }, ctx(root)),
      ).rejects.toThrow('cos fixed needs a due date');
    });
  });

  it('skips kind, cos and area validation in a root with no categories.yml', async () => {
    await withTempActiveRoot(async (root) => {
      const args = { kind: 'anything', cos: 'whatever', area: 'nowhere' };

      const created = await taskAdd.run({ slug: SLUG, title: 'Free', ...args }, ctx(root));

      expect(await readTask(root, (created as { id: string }).id)).toMatchObject(args);
    });
  });
});

describe('task edit with categories', () => {
  it('sets kind, cos, area and due from flags', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);

      await edit(root, { kind: 'bug', area: 'console', cos: 'fixed', due: '2026-11-01' });

      expect(await readTask(root, 'SI-1')).toMatchObject({
        kind: 'bug',
        area: 'console',
        cos: 'fixed',
        due: '2026-11-01',
      });
    });
  });

  it('refuses an unknown area and leaves the file untouched', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);
      const file = path.join(root, SLUG, 'tasks', 'SI-1.yml');
      const before = await fs.readFile(file, 'utf8');

      await expect(edit(root, { area: 'nowhere' })).rejects.toThrow(
        'Unknown area: nowhere (allowed: store, console)',
      );
      expect(await fs.readFile(file, 'utf8')).toBe(before);
    });
  });

  it.each(['wont-do', 'icebox'])('accepts the registry status %s', async (status) => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);

      await edit(root, { field: 'status', value: status });

      expect(await readTask(root, 'SI-1')).toMatchObject({ status, done_at: null });
    });
  });

  it('refuses a status the registry does not list', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);

      await expect(edit(root, { field: 'status', value: 'closed' })).rejects.toThrow(
        'Unknown status: closed (allowed: open, done, wont-do, icebox)',
      );
    });
  });

  it('keeps the built-in statuses in a root with no categories.yml', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(edit(root, { field: 'status', value: 'wont-do' })).rejects.toThrow(
        'Unknown status: wont-do (allowed: open, done)',
      );
    });
  });

  it('does not re-check an untouched axis that predates the registry', async () => {
    await withTempActiveRoot(async (root) => {
      await edit(root, { kind: 'legacy' });
      await writeRegistry(root);

      await edit(root, { area: 'store' });

      expect(await readTask(root, 'SI-1')).toMatchObject({ kind: 'legacy', area: 'store' });
    });
  });

  it('rejects a due date that is not YYYY-MM-DD', () => {
    expect(taskEdit.args.safeParse({ slug: SLUG, id: 'SI-1', due: 'soon' }).success).toBe(false);
  });
});

describe('category list', () => {
  it('prints every axis of the registry', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);

      const rows = await categoryList.run({}, ctx(root));

      expect(rows.filter((row) => row.axis === 'kind').map((row) => row.id)).toEqual(REGISTRY.kind);
      expect(rows).toContainEqual({
        axis: 'status',
        id: 'icebox',
        closed: false,
        dispatchable: false,
      });
      expect(rows).toContainEqual({ axis: 'area', id: 'console', tier: 'product' });
    });
  });

  it('narrows to one axis with --axis', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);

      const rows = await categoryList.run({ axis: 'cos' }, ctx(root));

      expect(rows).toEqual([
        { axis: 'cos', id: 'standard' },
        { axis: 'cos', id: 'fixed' },
      ]);
    });
  });

  it('returns nothing and warns in a root with no categories.yml', async () => {
    await withTempActiveRoot(async (root) => {
      const context = ctx(root);

      expect(await categoryList.run({}, context)).toEqual([]);
      expect(context.warnings[0]).toMatch(/No category registry/);
    });
  });
});

describe('category init', () => {
  async function tagTask(root: string, tags: string[]): Promise<void> {
    for (const tag of tags) await edit(root, { add_tag: tag });
  }

  it('seeds kinds and cos from tags, the four statuses and the given areas', async () => {
    await withTempActiveRoot(async (root) => {
      await tagTask(root, ['kind:feature', 'cos:standard', 'kind:Not_An_Id']);
      const areasFile = path.join(root, 'areas.yml');
      await fs.writeFile(areasFile, 'area:\n  - { id: store, tier: 0, path: packages/store }\n');
      const context = ctx(root);

      const result = await categoryInit.run({ areas: areasFile }, context);

      const onDisk = YAML.parse(await fs.readFile(registryPath(root), 'utf8'));
      expect(result.created).toBe(true);
      expect(onDisk).toEqual(result.registry);
      expect(onDisk.kind).toEqual(['epic', 'feature']);
      expect(onDisk.cos).toEqual(['standard']);
      expect(onDisk.status.map((s: { id: string }) => s.id)).toEqual([
        'open',
        'done',
        'wont-do',
        'icebox',
      ]);
      expect(onDisk.area).toEqual([{ id: 'store', tier: 0, path: 'packages/store' }]);
      expect(context.warnings).toContain('Skipped tags that are not category ids: kind:Not_An_Id');
    });
  });

  it('seeds an empty area list and says so without --areas', async () => {
    await withTempActiveRoot(async (root) => {
      const context = ctx(root);

      const result = await categoryInit.run({}, context);

      expect(result.registry.area).toEqual([]);
      expect(context.warnings.join('\n')).toMatch(/No --areas file/);
    });
  });

  it('leaves an existing categories.yml untouched on a second run', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);
      const before = await fs.readFile(registryPath(root), 'utf8');

      const result = await categoryInit.run({}, ctx(root));

      expect(result.created).toBe(false);
      expect(await fs.readFile(registryPath(root), 'utf8')).toBe(before);
    });
  });
});
