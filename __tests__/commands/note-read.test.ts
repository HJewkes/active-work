import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import noteReadCmd from '../../src/commands/note-read.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'garden';
const FILENAME = '2026-01-03-soil-ph.md';
const ctx = { activeRoot: '', warnings: [], format: 'json' as const };

async function put(root: string, rel: string, body: string): Promise<void> {
  const file = path.join(root, SLUG, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
}

const NOTE = `---\nkind: gotcha\ntitle: Soil pH drifts\ncreated: '2026-01-03'\ntags: [soil]\n---\n\nLime in autumn.\n`;

describe('note.read', () => {
  it('returns the fields and body for a filename or any path form', async () => {
    await withEmptyActiveRoot(async (root) => {
      await put(root, `sources/notes/${FILENAME}`, NOTE);

      for (const form of [
        FILENAME,
        `sources/notes/${FILENAME}`,
        `${SLUG}/sources/notes/${FILENAME}`,
      ]) {
        const res = await noteReadCmd.run({ slug: SLUG, note: form }, ctx);
        expect(res).toEqual({
          id: `${SLUG}:notes:${FILENAME}`,
          slug: SLUG,
          filename: FILENAME,
          path: `sources/notes/${FILENAME}`,
          kind: 'gotcha',
          title: 'Soil pH drifts',
          created: '2026-01-03',
          tags: ['soil'],
          body: '\nLime in autumn.\n',
          truncated: false,
        });
      }
    });
  });

  it('refuses a file in the initiative that is not under sources/notes/', async () => {
    await withEmptyActiveRoot(async (root) => {
      await put(root, 'sources/deepdive-beds.md', NOTE);
      await expect(
        noteReadCmd.run({ slug: SLUG, note: 'sources/deepdive-beds.md' }, ctx),
      ).rejects.toThrow(/Not a note/);
    });
  });

  it('refuses a filename that climbs out of the notes directory', async () => {
    await withEmptyActiveRoot(async (root) => {
      await put(root, 'brief.md', '# Garden\n');
      await expect(
        noteReadCmd.run({ slug: SLUG, note: 'sources/notes/../../brief.md' }, ctx),
      ).rejects.toThrow(/Not a note/);
    });
  });

  it('rejects a note whose frontmatter does not validate', async () => {
    await withEmptyActiveRoot(async (root) => {
      await put(root, 'sources/notes/2026-01-04-bad.md', '---\nkind: rumour\n---\nbody\n');
      await expect(noteReadCmd.run({ slug: SLUG, note: '2026-01-04-bad.md' }, ctx)).rejects.toThrow(
        /Not a valid note/,
      );
    });
  });

  it('reports a missing note as not found', async () => {
    await withEmptyActiveRoot(async (root) => {
      await put(root, 'brief.md', '# Garden\n');
      await expect(noteReadCmd.run({ slug: SLUG, note: 'nope.md' }, ctx)).rejects.toThrow(
        /not found/,
      );
    });
  });
});
