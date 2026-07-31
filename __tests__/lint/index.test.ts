import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintAll, lintSlug } from '../../src/lint/index.js';
import { recordArtifactHash } from '../../src/utils/artifact-hash.js';
import { withEmptyActiveRoot, withTempActiveRoot } from '../setup/test-helpers.js';

const TIGHT_LIMITS = {
  briefMaxBodyLines: 4,
  taskNotesMaxLines: 2,
};

async function scaffoldInitiative(
  root: string,
  slug: string,
  opts: { briefBodyLines: number; notesLines: number },
): Promise<void> {
  const dir = path.join(root, slug);
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });

  const briefBody = Array.from({ length: opts.briefBodyLines }, (_, i) => `brief ${i + 1}`).join(
    '\n',
  );
  const briefContent = [
    '---',
    'schema_version: 1',
    `title: ${slug}`,
    'state: focused',
    '---',
    '',
    briefBody,
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'brief.md'), briefContent, 'utf8');

  const notesBlock = Array.from({ length: opts.notesLines }, (_, i) => `  n${i + 1}`).join('\n');
  const taskYml = [
    'id: AA-1',
    'title: t',
    'priority: 1',
    'status: open',
    'created: 2026-05-09',
    'updated: 2026-05-10',
    'done_at: null',
    'notes: |',
    notesBlock,
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'tasks', 'AA-1.yml'), taskYml, 'utf8');
}

describe('lintSlug', () => {
  it('aggregates findings across brief and tasks', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffoldInitiative(root, 'alpha', {
        briefBodyLines: 6,
        notesLines: 4,
      });
      const findings = await lintSlug('alpha', { activeRoot: root, limits: TIGHT_LIMITS });
      const files = findings.map((f) => f.file).sort();
      expect(files).toEqual(['brief.md', 'tasks/AA-1.yml']);
      for (const f of findings) {
        expect(f.slug).toBe('alpha');
        expect(f.level).toBe('warn');
      }
    });
  });

  it('returns nothing on the clean fixture', async () => {
    await withTempActiveRoot(async (root) => {
      const findings = await lintSlug('sample-initiative', { activeRoot: root });
      expect(findings).toEqual([]);
    });
  });

  it('surfaces a hash-drift finding alongside other lints', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const filePath = path.join(dir, 'artifacts.yml');
      const original = await fs.readFile(filePath, 'utf8');
      await recordArtifactHash(dir, 'artifacts.yml', original);
      await fs.writeFile(filePath, `${original}\n# hand-edited\n`);

      const findings = await lintSlug('sample-initiative', { activeRoot: root });
      const files = findings.map((f) => f.file).sort();
      expect(files).toEqual(['artifacts.yml']);
    });
  });
});

describe('lintAll', () => {
  it('enumerates initiatives and aggregates per-slug findings', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffoldInitiative(root, 'alpha', {
        briefBodyLines: 2,
        notesLines: 1,
      });
      await scaffoldInitiative(root, 'beta', {
        briefBodyLines: 10,
        notesLines: 10,
      });
      await scaffoldInitiative(root, 'gamma', {
        briefBodyLines: 1,
        notesLines: 1,
      });

      const findings = await lintAll({ activeRoot: root, limits: TIGHT_LIMITS });
      const bySlug = new Map<string, number>();
      for (const f of findings) bySlug.set(f.slug, (bySlug.get(f.slug) ?? 0) + 1);
      expect(bySlug.get('alpha')).toBeUndefined();
      expect(bySlug.get('beta')).toBe(2);
      expect(bySlug.get('gamma')).toBeUndefined();
    });
  });

  it('returns [] when the active root is empty', async () => {
    await withEmptyActiveRoot(async (root) => {
      const findings = await lintAll({ activeRoot: root });
      expect(findings).toEqual([]);
    });
  });

  it('skips dotfile entries when enumerating', async () => {
    await withEmptyActiveRoot(async (root) => {
      await fs.writeFile(path.join(root, '.schema-version'), '1\n', 'utf8');
      await fs.mkdir(path.join(root, '.cache'), { recursive: true });
      await scaffoldInitiative(root, 'alpha', {
        briefBodyLines: 1,
        notesLines: 1,
      });
      const findings = await lintAll({ activeRoot: root, limits: TIGHT_LIMITS });
      expect(findings.every((f) => f.slug === 'alpha')).toBe(true);
    });
  });
});
