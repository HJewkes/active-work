import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import noteAddCmd from '../../src/commands/note-add.js';
import noteListCmd from '../../src/commands/note-list.js';
import { NOTE_TITLE_MAX_LENGTH, NoteFrontmatterSchema } from '../../src/schemas/note.js';
import { readFrontmatter } from '../../src/utils/gray-matter-io.js';
import { today } from '../../src/utils/today.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const ctx = { activeRoot: '', warnings: [], format: 'json' as const };

function notesDir(root: string): string {
  return path.join(root, SLUG, 'sources', 'notes');
}

async function writeNoteFixture(root: string, filename: string, contents: string): Promise<void> {
  await fs.mkdir(notesDir(root), { recursive: true });
  await fs.writeFile(path.join(notesDir(root), filename), contents, 'utf8');
}

function noteFixture(kind: string, title: string, created: string): string {
  return `---\nkind: ${kind}\ntitle: ${title}\ncreated: '${created}'\n---\n\n${title} body\n`;
}

describe('note.add', () => {
  it('round-trips through the validating writer', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await noteAddCmd.run(
        {
          slug: SLUG,
          kind: 'gotcha',
          title: 'Env Paths Ignores XDG on darwin',
          body: 'Use ACTIVE_ROOT instead.',
          tags: ['testing', 'fs'],
        },
        ctx,
      );

      const expected = path.join(notesDir(root), `${today()}-env-paths-ignores-xdg-on-darwin.md`);
      expect(res.path).toBe(expected);
      expect(res.kind).toBe('gotcha');

      const { frontmatter, body } = await readFrontmatter(expected, NoteFrontmatterSchema);
      expect(frontmatter).toEqual({
        kind: 'gotcha',
        title: 'Env Paths Ignores XDG on darwin',
        created: today(),
        tags: ['testing', 'fs'],
      });
      expect(body.trim()).toBe('Use ACTIVE_ROOT instead.');
    });
  });

  it('reads the body from --body-file', async () => {
    await withTempActiveRoot(async (root) => {
      const bodyPath = path.join(root, 'body.md');
      await fs.writeFile(bodyPath, 'From a file.', 'utf8');

      const res = await noteAddCmd.run(
        { slug: SLUG, kind: 'process', title: 'From File', body_file: bodyPath },
        ctx,
      );

      const { body } = await readFrontmatter(res.path, NoteFrontmatterSchema);
      expect(body.trim()).toBe('From a file.');
    });
  });

  it('rejects an unknown kind', () => {
    expect(
      noteAddCmd.args.safeParse({
        slug: SLUG,
        kind: 'idea',
        title: 'Nope',
        body: 'x',
      }).success,
    ).toBe(false);
  });

  it('requires exactly one of --body and --body-file', () => {
    const base = { slug: SLUG, kind: 'fyi', title: 'Body rules' };
    expect(noteAddCmd.args.safeParse(base).success).toBe(false);
    expect(noteAddCmd.args.safeParse({ ...base, body: 'a', body_file: '/tmp/b.md' }).success).toBe(
      false,
    );
    expect(noteAddCmd.args.safeParse({ ...base, body: 'a' }).success).toBe(true);
  });

  it('rejects a title longer than the bound', () => {
    const base = { slug: SLUG, kind: 'fyi' as const, body: 'x' };
    expect(
      noteAddCmd.args.safeParse({ ...base, title: 'a'.repeat(NOTE_TITLE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      noteAddCmd.args.safeParse({ ...base, title: 'a'.repeat(NOTE_TITLE_MAX_LENGTH) }).success,
    ).toBe(true);
  });

  it('parks a same-day duplicate title beside the original', async () => {
    await withTempActiveRoot(async () => {
      const args = { slug: SLUG, kind: 'fyi' as const, title: 'Same Title', body: 'one' };
      const first = await noteAddCmd.run(args, ctx);
      const second = await noteAddCmd.run({ ...args, body: 'two' }, ctx);

      expect(first.filename).toBe(`${today()}-same-title.md`);
      expect(second.filename).toBe(`${today()}-same-title-1.md`);
    });
  });

  it('rejects an unknown initiative', async () => {
    await withTempActiveRoot(async () => {
      await expect(
        noteAddCmd.run({ slug: 'does-not-exist', kind: 'fyi', title: 'Nope', body: 'x' }, ctx),
      ).rejects.toThrow(/not found/i);
    });
  });
});

describe('note.list', () => {
  it('returns notes newest first', async () => {
    await withTempActiveRoot(async (root) => {
      await writeNoteFixture(
        root,
        '2026-01-02-older.md',
        noteFixture('fyi', 'Older', '2026-01-02'),
      );
      await writeNoteFixture(
        root,
        '2026-07-01-newer.md',
        noteFixture('process', 'Newer', '2026-07-01'),
      );

      const res = await noteListCmd.run({ slug: SLUG }, ctx);
      expect(res.notes.map((n) => n.title)).toEqual(['Newer', 'Older']);
      expect(res.errors).toEqual([]);
    });
  });

  it('filters by kind', async () => {
    await withTempActiveRoot(async (root) => {
      await writeNoteFixture(root, '2026-01-02-a.md', noteFixture('fyi', 'A', '2026-01-02'));
      await writeNoteFixture(root, '2026-01-03-b.md', noteFixture('gotcha', 'B', '2026-01-03'));

      const res = await noteListCmd.run({ slug: SLUG, kind: 'gotcha' }, ctx);
      expect(res.notes.map((n) => n.title)).toEqual(['B']);
    });
  });

  it('surfaces malformed notes instead of skipping them', async () => {
    await withTempActiveRoot(async (root) => {
      await writeNoteFixture(root, '2026-01-02-good.md', noteFixture('fyi', 'Good', '2026-01-02'));
      await writeNoteFixture(root, '2026-01-03-bad.md', '---\nkind: mystery\n---\nnope\n');

      const res = await noteListCmd.run({ slug: SLUG }, ctx);
      expect(res.notes.map((n) => n.title)).toEqual(['Good']);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]!.filename).toBe('2026-01-03-bad.md');
    });
  });

  it('returns empty when the notes directory is absent', async () => {
    await withTempActiveRoot(async () => {
      const res = await noteListCmd.run({ slug: SLUG }, ctx);
      expect(res).toEqual({ notes: [], errors: [] });
    });
  });
});
