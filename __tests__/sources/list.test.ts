import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractSourceReferences, listSources } from '../../src/sources/list.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

async function writeSources(root: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, SLUG, 'sources');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body, 'utf8');
  }
  return path.join(root, SLUG);
}

describe('listSources', () => {
  it('derives the listing from the directory, including files nothing references', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await writeSources(root, {
        'pr-123-fix-bug.md': '# Fix bug\n',
        'deepdive-caching.md': '# Caching deep dive\n',
        'hand-dropped.md': '# Dropped in by hand\n',
      });
      const sources = await listSources(dir);
      expect(sources.map((s) => s.filename)).toEqual([
        'deepdive-caching.md',
        'hand-dropped.md',
        'pr-123-fix-bug.md',
      ]);
    });
  });

  it('infers type from the filename convention source.add writes', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await writeSources(root, {
        'pr-7-thing.md': '# PR\n',
        'deepdive-topic.md': '# Deep dive\n',
        '2026-04-01-kickoff.md': '# Kickoff\n',
        'design-doc.md': '# Design\n',
      });
      const byName = new Map((await listSources(dir)).map((s) => [s.filename, s.type]));
      expect(byName.get('pr-7-thing.md')).toBe('pr');
      expect(byName.get('deepdive-topic.md')).toBe('deepdive');
      expect(byName.get('2026-04-01-kickoff.md')).toBe('session');
      expect(byName.get('design-doc.md')).toBe('pointer');
    });
  });

  it('titles from the first heading and falls back to the filename stem', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await writeSources(root, {
        'a-titled.md': 'preamble\n\n## Real Title\n\nbody\n',
        'b-untitled.md': 'just prose, no heading\n',
      });
      const sources = await listSources(dir);
      expect(sources[0].title).toBe('Real Title');
      expect(sources[1].title).toBe('b-untitled');
    });
  });

  it('skips non-markdown, dotfiles, and the notes subdirectory', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await writeSources(root, {
        'keep.md': '# Keep\n',
        'ignore.txt': 'nope',
        '.hidden.md': '# Hidden\n',
      });
      await fs.mkdir(path.join(dir, 'sources', 'notes'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'sources', 'notes', '2026-01-01-a-note.md'),
        '# A note\n',
        'utf8',
      );
      const sources = await listSources(dir);
      expect(sources.map((s) => s.filename)).toEqual(['keep.md']);
    });
  });

  it('returns an empty list when sources/ does not exist', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, SLUG);
      await fs.rm(path.join(dir, 'sources'), { recursive: true, force: true });
      expect(await listSources(dir)).toEqual([]);
    });
  });

  it('reflects a file added after a previous listing', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = await writeSources(root, { 'first.md': '# First\n' });
      expect((await listSources(dir)).map((s) => s.filename)).toEqual(['first.md']);
      await fs.writeFile(path.join(dir, 'sources', 'second.md'), '# Second\n', 'utf8');
      expect((await listSources(dir)).map((s) => s.filename)).toEqual(['first.md', 'second.md']);
    });
  });
});

describe('extractSourceReferences', () => {
  it('collects deduped sources paths from markdown prose and links', () => {
    const body = [
      '## References',
      '- [PR](sources/pr-1-a.md) — a thing',
      '- see `sources/deepdive-b.md`',
      '- again sources/pr-1-a.md',
      '- nested sources/notes/2026-01-01-x.md',
    ].join('\n');
    expect(extractSourceReferences(body)).toEqual([
      'deepdive-b.md',
      'notes/2026-01-01-x.md',
      'pr-1-a.md',
    ]);
  });

  it('returns nothing when the body never links into sources/', () => {
    expect(extractSourceReferences('# Brief\n\nWhy: because\n')).toEqual([]);
  });
});
