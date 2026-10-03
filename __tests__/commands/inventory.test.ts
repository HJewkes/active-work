import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import inventoryCmd from '../../src/commands/inventory.js';
import { scanInventory } from '../../src/workspace-index/inventory.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const ctx = () => ({ activeRoot: '', warnings: [] as string[], format: 'json' as const });

async function put(root: string, rel: string, body: string, mtime?: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
  if (mtime) await fs.utimes(file, new Date(mtime), new Date(mtime));
}

async function writeCharter(root: string, humanOnly: string[]): Promise<void> {
  const list = `human_only_initiatives: ${JSON.stringify(humanOnly)}\n`;
  await put(root, 'claude-channels/sources/autonomy/charter.md', `---\n${list}---\nCharter\n`);
}

async function seedGarden(root: string): Promise<void> {
  await put(root, 'garden/brief.md', '# Garden\n');
  await put(root, 'garden/tasks/GD-1.yml', 'id: GD-1\n');
  await put(root, 'garden/tasks/archive/GD-0.yml', 'id: GD-0\n');
  await put(root, 'garden/sessions/2026-01-02-a.md', 'session\n');
  await put(root, 'garden/sources/notes/2026-01-03-soil.md', 'note\n');
  await put(root, 'garden/sources/deepdive-beds.md', '# Beds\n');
  await put(root, 'garden/sources/research/seeds/tomato.md', 'aaaa', '2026-03-01T00:00:00.000Z');
  await put(root, 'garden/sources/research/peppers.jsonl', 'bb', '2026-02-01T00:00:00.000Z');
  await put(root, 'garden/sources/photos/bed.txt', 'c', '2026-01-15T00:00:00.000Z');
}

describe('inventory', () => {
  it('counts files, bytes and newest mtime per class, keeping nested sources separate', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGarden(root);
      await writeCharter(root, []);

      const res = await inventoryCmd.run({}, ctx());
      const garden = res.initiatives.find((row) => row.slug === 'garden')!;

      expect(garden.classes.task.files).toBe(2);
      expect(garden.classes.note.files).toBe(1);
      expect(garden.classes.source.files).toBe(1);
      expect(garden.classes.nested_source).toEqual({
        files: 3,
        bytes: 7,
        newest_mtime: '2026-03-01T00:00:00.000Z',
      });
      expect(garden.nested_dirs).toEqual([
        { dir: 'sources/photos', files: 1, bytes: 1, newest_mtime: '2026-01-15T00:00:00.000Z' },
        { dir: 'sources/research', files: 2, bytes: 6, newest_mtime: '2026-03-01T00:00:00.000Z' },
      ]);
      expect(garden.total.files).toBe(9);
    });
  });

  it('lists an initiative with no files and sums every initiative into totals', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGarden(root);
      await writeCharter(root, []);
      await fs.mkdir(path.join(root, 'empty-one'));

      const res = await inventoryCmd.run({}, ctx());
      const empty = res.initiatives.find((row) => row.slug === 'empty-one')!;

      expect(empty.total).toEqual({ files: 0, bytes: 0, newest_mtime: null });
      const summed = res.initiatives.reduce((n, row) => n + row.total.files, 0);
      expect(res.totals.total.files).toBe(summed);
      expect(res.totals.classes.nested_source.files).toBe(4); // garden 3 plus the charter
    });
  });

  it('flags initiatives the charter marks human-only', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGarden(root);
      await writeCharter(root, ['garden']);

      const res = await inventoryCmd.run({}, ctx());

      expect(res.human_only_known).toBe(true);
      expect(res.initiatives.find((row) => row.slug === 'garden')!.human_only).toBe(true);
      expect(res.initiatives.find((row) => row.slug === 'claude-channels')!.human_only).toBe(false);
    });
  });

  it('flags every initiative and warns when the charter is unreadable', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGarden(root);
      const context = ctx();

      const res = await inventoryCmd.run({}, context);

      expect(res.human_only_known).toBe(false);
      expect(res.initiatives.every((row) => row.human_only)).toBe(true);
      expect(context.warnings.join('\n')).toMatch(/human_only_initiatives/);
    });
  });

  it('marks nested sources as unindexed and every other file as indexed', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGarden(root);

      const files = await scanInventory(root);
      const unindexed = files.filter((file) => !file.indexed).map((file) => file.path);

      expect(unindexed).toEqual([
        'garden/sources/photos/bed.txt',
        'garden/sources/research/peppers.jsonl',
        'garden/sources/research/seeds/tomato.md',
      ]);
    });
  });
});
