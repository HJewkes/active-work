import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import sourceListCmd from '../../src/commands/source-list.js';
import sourceAddCmd from '../../src/commands/source-add.js';
import { withEmptyActiveRoot, withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const ctx = { activeRoot: '', warnings: [], format: 'json' as const };

async function writeSourceFiles(root: string, names: string[]): Promise<string> {
  const dir = path.join(root, SLUG, 'sources');
  await fs.mkdir(dir, { recursive: true });
  for (const name of names) {
    await fs.writeFile(path.join(dir, name), `# ${name}\n`, 'utf8');
  }
  return dir;
}

describe('source.list', () => {
  it('lists what is on disk, sorted, with no index file involved', async () => {
    await withTempActiveRoot(async (root) => {
      await writeSourceFiles(root, ['pr-9-b.md', 'deepdive-a.md']);
      const res = await sourceListCmd.run({ slug: SLUG }, ctx);
      expect(res.sources.map((s) => s.filename)).toEqual(['deepdive-a.md', 'pr-9-b.md']);
      expect(res.drift).toEqual([]);
    });
  });

  it('filters by type', async () => {
    await withTempActiveRoot(async (root) => {
      await writeSourceFiles(root, ['pr-9-b.md', 'deepdive-a.md']);
      const res = await sourceListCmd.run({ slug: SLUG, type: 'pr' }, ctx);
      expect(res.sources.map((s) => s.filename)).toEqual(['pr-9-b.md']);
    });
  });

  it('picks up a source added by source.add without any index update', async () => {
    await withTempActiveRoot(async (root) => {
      const inbox = path.join(root, '_inbox');
      await fs.mkdir(inbox, { recursive: true });
      const raw = path.join(inbox, 'raw.md');
      await fs.writeFile(raw, '# Fresh\n', 'utf8');
      await sourceAddCmd.run(
        { slug: SLUG, file: raw, type: 'deepdive', topic: 'Caching Strategy' },
        ctx,
      );
      const res = await sourceListCmd.run({ slug: SLUG }, ctx);
      expect(res.sources).toEqual([
        expect.objectContaining({
          filename: 'deepdive-caching-strategy.md',
          type: 'deepdive',
          title: 'Fresh',
        }),
      ]);
    });
  });

  it('reports drift when the brief reference list omits a file', async () => {
    await withTempActiveRoot(async (root) => {
      await writeSourceFiles(root, ['pr-1-a.md', 'deepdive-forgotten.md']);
      await fs.writeFile(
        path.join(root, SLUG, 'brief.md'),
        [
          '---',
          'schema_version: 1',
          'title: Sample',
          'state: focused',
          '---',
          '## References',
          '- sources/pr-1-a.md',
          '',
        ].join('\n'),
        'utf8',
      );
      const res = await sourceListCmd.run({ slug: SLUG }, ctx);
      expect(res.drift).toHaveLength(1);
      expect(res.drift[0]).toContain('sources/deepdive-forgotten.md');
    });
  });

  it('returns an empty listing for an initiative with no sources', async () => {
    await withTempActiveRoot(async (root) => {
      await fs.rm(path.join(root, SLUG, 'sources'), { recursive: true, force: true });
      const res = await sourceListCmd.run({ slug: SLUG }, ctx);
      expect(res).toEqual({ sources: [], drift: [] });
    });
  });

  it('lists nested sources by path only when asked', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await writeSourceFiles(root, ['deepdive-a.md']);
      await fs.mkdir(path.join(dir, 'research', 'deep'), { recursive: true });
      await fs.writeFile(path.join(dir, 'research', 'deep', 'x.md'), '# Deep X\n', 'utf8');
      await fs.writeFile(path.join(dir, 'research', 'raw.jsonl'), '{}\n', 'utf8');
      await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
      await fs.writeFile(path.join(dir, 'notes', '2026-01-01-n.md'), 'note\n', 'utf8');

      const flat = await sourceListCmd.run({ slug: SLUG }, ctx);
      const nested = await sourceListCmd.run({ slug: SLUG, nested: true }, ctx);

      expect(flat.sources.map((s) => s.filename)).toEqual(['deepdive-a.md']);
      expect(nested.sources.find((s) => s.nested)!.id).toBe(`${SLUG}:sources:research/deep/x.md`);
      expect(nested.sources.map((s) => [s.filename, s.title, s.nested])).toEqual([
        ['deepdive-a.md', 'deepdive-a.md', false],
        ['research/deep/x.md', 'Deep X', true],
        ['research/raw.jsonl', 'research/raw.jsonl', true],
      ]);
    });
  });

  it('lists sources from every initiative, each tagged with its slug', async () => {
    await withEmptyActiveRoot(async (root) => {
      for (const slug of ['alpha', 'beta']) {
        await fs.mkdir(path.join(root, slug, 'sources'), { recursive: true });
        await fs.writeFile(path.join(root, slug, 'sources', `pr-1-${slug}.md`), '# PR\n', 'utf8');
      }

      const res = await sourceListCmd.run({ all_initiatives: true }, ctx);
      expect(res.sources.map((s) => s.id)).toEqual([
        'alpha:sources:pr-1-alpha.md',
        'beta:sources:pr-1-beta.md',
      ]);
      expect(res.sources.every((s) => s.mtime !== null && !Number.isNaN(Date.parse(s.mtime)))).toBe(
        true,
      );
    });
  });

  it('refuses a slug together with all_initiatives', async () => {
    await withEmptyActiveRoot(async () => {
      await expect(sourceListCmd.run({ slug: SLUG, all_initiatives: true }, ctx)).rejects.toThrow(
        /not both/,
      );
    });
  });
});
