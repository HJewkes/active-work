import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import noteAddCmd from '../../src/commands/note-add.js';
import noteListCmd from '../../src/commands/note-list.js';
import { NOTE_TITLE_MAX_LENGTH, NoteFrontmatterSchema } from '../../src/schemas/note.js';
import { readFrontmatter } from '../../src/utils/gray-matter-io.js';
import { today } from '../../src/utils/today.js';
import { withEmptyActiveRoot, withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const ctx = { activeRoot: '', warnings: [], format: 'json' as const };

function notesDir(root: string): string {
  return path.join(root, SLUG, 'sources', 'notes');
}

async function writeNoteFixture(root: string, filename: string, contents: string): Promise<void> {
  await fs.mkdir(notesDir(root), { recursive: true });
  await fs.writeFile(path.join(notesDir(root), filename), contents, 'utf8');
}

async function writeNoteIn(root: string, slug: string, name: string, body: string): Promise<void> {
  const dir = path.join(root, slug, 'sources', 'notes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), body, 'utf8');
}

function noteFixture(kind: string, title: string, created: string): string {
  return `---\nkind: ${kind}\ntitle: ${title}\ncreated: '${created}'\n---\n\n${title} body\n`;
}

async function writeCharter(root: string, humanOnly: string[]): Promise<void> {
  const file = path.join(root, 'claude-channels', 'sources', 'autonomy', 'charter.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const list = `human_only_initiatives: ${JSON.stringify(humanOnly)}\n`;
  await fs.writeFile(file, `---\n${list}---\nCharter\n`, 'utf8');
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

  it('accepts plan, a kind the corpus used before the enum did', () => {
    // Eleven notes across three initiatives carried `kind: plan` and the loader
    // dropped every one. A kind the corpus already uses is a kind.
    expect(
      noteAddCmd.args.safeParse({ slug: SLUG, kind: 'plan', title: 'Shape', body: 'x' }).success,
    ).toBe(true);
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
      expect(res).toMatchObject({ notes: [], errors: [] });
    });
  });

  it('lists notes from every initiative, newest first, each tagged with its slug', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeNoteIn(root, 'alpha', '2026-01-02-a.md', noteFixture('fyi', 'A', '2026-01-02'));
      await writeNoteIn(root, 'beta', '2026-03-01-b.md', noteFixture('plan', 'B', '2026-03-01'));
      await writeNoteIn(root, 'beta', '2026-01-05-bad.md', '---\nkind: mystery\n---\nnope\n');

      const res = await noteListCmd.run({ all_initiatives: true }, ctx);
      expect(res.notes.map((n) => n.id)).toEqual([
        'beta:notes:2026-03-01-b.md',
        'alpha:notes:2026-01-02-a.md',
      ]);
      expect(res.notes.every((n) => n.mtime !== null)).toBe(true);
      expect(res.errors.map((e) => [e.slug, e.filename])).toEqual([['beta', '2026-01-05-bad.md']]);
    });
  });

  it('flags notes from a human-only initiative across initiatives', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeNoteIn(root, 'alpha', '2026-01-02-a.md', noteFixture('fyi', 'A', '2026-01-02'));
      await writeNoteIn(root, 'beta', '2026-03-01-b.md', noteFixture('plan', 'B', '2026-03-01'));
      await writeCharter(root, ['beta']);
      const context = { activeRoot: '', warnings: [] as string[], format: 'json' as const };

      const res = await noteListCmd.run({ all_initiatives: true }, context);

      expect(res.human_only_known).toBe(true);
      expect(res.notes.map((n) => [n.slug, n.human_only])).toEqual([
        ['beta', true],
        ['alpha', false],
      ]);
      expect(context.warnings).toEqual([]);
    });
  });

  it('flags every note and warns when the charter is unreadable', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeNoteIn(root, 'alpha', '2026-01-02-a.md', noteFixture('fyi', 'A', '2026-01-02'));
      await writeNoteIn(root, 'beta', '2026-03-01-b.md', noteFixture('plan', 'B', '2026-03-01'));
      const charter = path.join(root, 'claude-channels', 'sources', 'autonomy', 'charter.md');
      await fs.mkdir(path.dirname(charter), { recursive: true });
      await fs.writeFile(charter, '---\nhuman_only_initiatives: not-a-list\n---\n', 'utf8');
      const context = { activeRoot: '', warnings: [] as string[], format: 'json' as const };

      const res = await noteListCmd.run({ all_initiatives: true }, context);

      expect(res.human_only_known).toBe(false);
      expect(res.notes).toHaveLength(2);
      expect(res.notes.every((n) => n.human_only)).toBe(true);
      expect(context.warnings.join('\n')).toMatch(/human_only_initiatives/);
    });
  });

  it('flags a single human-only initiative listed by slug', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeNoteIn(root, 'beta', '2026-03-01-b.md', noteFixture('plan', 'B', '2026-03-01'));
      await writeCharter(root, ['beta']);

      const res = await noteListCmd.run({ slug: 'beta' }, ctx);

      expect(res.human_only_known).toBe(true);
      expect(res.notes.map((n) => n.human_only)).toEqual([true]);
    });
  });

  it('refuses to run with neither a slug nor all_initiatives', async () => {
    await withEmptyActiveRoot(async () => {
      await expect(noteListCmd.run({}, ctx)).rejects.toThrow(/requires a slug/);
    });
  });

  it.each(['..', '.', 'Bad Slug', 'a/b'])('refuses the invalid slug %j', async (slug) => {
    await withEmptyActiveRoot(async () => {
      await expect(noteListCmd.run({ slug }, ctx)).rejects.toThrow(/Invalid slug/);
    });
  });
});
