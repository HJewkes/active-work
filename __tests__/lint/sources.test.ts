import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { lintSources } from '../../src/lint/sources.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

const FRONTMATTER = ['---', 'schema_version: 1', 'title: Sample', 'state: focused', '---'];

async function setup(root: string, briefBody: string[], sources: string[]): Promise<string> {
  const dir = path.join(root, SLUG);
  await fs.writeFile(
    path.join(dir, 'brief.md'),
    [...FRONTMATTER, ...briefBody, ''].join('\n'),
    'utf8',
  );
  const sourcesDir = path.join(dir, 'sources');
  await fs.mkdir(sourcesDir, { recursive: true });
  for (const name of sources) {
    await fs.writeFile(path.join(sourcesDir, name), `# ${name}\n`, 'utf8');
  }
  return dir;
}

describe('lintSources', () => {
  it('flags a file on disk that the brief reference list omits', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await setup(
        root,
        ['## References', '- [PR](sources/pr-1-a.md)'],
        ['pr-1-a.md', 'deepdive-forgotten.md'],
      );
      const findings = await lintSources(SLUG, dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ level: 'warn', slug: SLUG, file: 'brief.md' });
      expect(findings[0].message).toContain('sources/deepdive-forgotten.md');
      expect(findings[0].message).toContain('active-work source list');
    });
  });

  it('flags a reference pointing at a file that does not exist', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await setup(
        root,
        ['## References', '- sources/pr-1-a.md', '- sources/gone.md'],
        ['pr-1-a.md'],
      );
      const findings = await lintSources(SLUG, dir);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('references sources/gone.md, which does not exist');
    });
  });

  it('is silent when references and directory agree', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await setup(
        root,
        ['## References', '- sources/pr-1-a.md', '- sources/deepdive-b.md'],
        ['pr-1-a.md', 'deepdive-b.md'],
      );
      expect(await lintSources(SLUG, dir)).toEqual([]);
    });
  });

  it('does not nag a brief that keeps no reference list at all', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await setup(root, ['# Sample', '', 'Why: because'], ['pr-1-a.md']);
      expect(await lintSources(SLUG, dir)).toEqual([]);
    });
  });

  it('ignores sources/notes/ when deciding what drifted', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await setup(root, ['## References', '- sources/pr-1-a.md'], ['pr-1-a.md']);
      await fs.mkdir(path.join(dir, 'sources', 'notes'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'sources', 'notes', '2026-01-01-a-note.md'),
        '# note\n',
        'utf8',
      );
      expect(await lintSources(SLUG, dir)).toEqual([]);
    });
  });

  it('returns no findings when brief.md is absent', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, SLUG);
      await fs.rm(path.join(dir, 'brief.md'));
      expect(await lintSources(SLUG, dir)).toEqual([]);
    });
  });
});
