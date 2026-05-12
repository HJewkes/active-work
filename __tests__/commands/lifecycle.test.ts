import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';
import newCmd from '../../src/commands/new.js';
import setCmd from '../../src/commands/set.js';
import touchCmd from '../../src/commands/touch.js';
import pathsCmd from '../../src/commands/paths.js';
import renameCmd from '../../src/commands/rename.js';
import archiveCmd from '../../src/commands/archive.js';
import { BriefFrontmatterSchema } from '../../src/schemas/brief.js';
import { NotFoundError, UsageError, ValidationError } from '../../src/errors.js';
import { today } from '../../src/utils/today.js';

function ctxFor(activeRoot: string) {
  return {
    activeRoot,
    warnings: [] as string[],
    format: 'json' as const,
  };
}

describe('new', () => {
  it('scaffolds the expected directory tree with parseable brief', async () => {
    await withEmptyActiveRoot(async (root) => {
      const out = await newCmd.run(
        { slug: 'alpha-init', title: 'Alpha Init', worktree: '~/code/alpha' },
        ctxFor(root),
      );
      expect(out.rank).toBe(1);
      expect(out.task_prefix).toBe('AI');
      expect(out.slug).toBe('alpha-init');
      expect(out.dir).toBe(path.join(root, 'alpha-init'));

      const briefPath = path.join(root, 'alpha-init', 'brief.md');
      expect((await fs.stat(briefPath)).isFile()).toBe(true);
      expect((await fs.stat(path.join(root, 'alpha-init', 'handoff.md'))).isFile()).toBe(true);
      expect(
        (await fs.stat(path.join(root, 'alpha-init', 'artifacts.yml'))).isFile(),
      ).toBe(true);
      expect(
        (await fs.stat(path.join(root, 'alpha-init', 'tasks'))).isDirectory(),
      ).toBe(true);
      expect(
        (await fs.stat(path.join(root, 'alpha-init', 'sessions'))).isDirectory(),
      ).toBe(true);
      expect(
        (await fs.stat(path.join(root, 'alpha-init', 'sources'))).isDirectory(),
      ).toBe(true);

      const raw = await fs.readFile(briefPath, 'utf8');
      const parsed = matter(raw);
      const result = BriefFrontmatterSchema.safeParse(parsed.data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe('Alpha Init');
        expect(result.data.rank).toBe(1);
        expect(result.data.task_prefix).toBe('AI');
        expect(result.data.state).toBe('focused');
        expect(result.data.worktrees?.main.path).toBe('~/code/alpha');
        expect(result.data.worktrees?.main.default).toBe(true);
      }
    });
  });

  it('gives the second focused initiative rank 2', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'one-thing', title: 'One' }, ctxFor(root));
      const out = await newCmd.run({ slug: 'two-thing', title: 'Two' }, ctxFor(root));
      expect(out.rank).toBe(2);
    });
  });

  it('refuses a duplicate slug', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'dup', title: 'D' }, ctxFor(root));
      await expect(
        newCmd.run({ slug: 'dup', title: 'D2' }, ctxFor(root)),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('rejects an invalid slug', async () => {
    await withEmptyActiveRoot(async (root) => {
      await expect(
        newCmd.run({ slug: 'Bad Slug', title: 'X' }, ctxFor(root)),
      ).rejects.toThrow(ValidationError);
    });
  });
});

describe('set', () => {
  it('updates a top-level field and stamps updated', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'sf', title: 'SF' }, ctxFor(root));
      const briefPath = path.join(root, 'sf', 'brief.md');
      // Backdate updated so we can prove it gets stamped.
      const before = await fs.readFile(briefPath, 'utf8');
      const stale = before.replace(/updated: .+/, 'updated: 2024-01-01');
      await fs.writeFile(briefPath, stale, 'utf8');

      await setCmd.run(
        { slug: 'sf', field: 'owner', value: 'henry' },
        ctxFor(root),
      );

      const parsed = matter(await fs.readFile(briefPath, 'utf8'));
      expect((parsed.data as Record<string, unknown>).owner).toBe('henry');
      expect((parsed.data as Record<string, unknown>).updated).toBe(today());
    });
  });

  it('updates a nested field via dot syntax', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run(
        { slug: 'nest', title: 'N', worktree: '~/old' },
        ctxFor(root),
      );
      await setCmd.run(
        { slug: 'nest', field: 'worktrees.main.path', value: '~/new-path' },
        ctxFor(root),
      );
      const parsed = matter(
        await fs.readFile(path.join(root, 'nest', 'brief.md'), 'utf8'),
      );
      const data = parsed.data as Record<string, Record<string, Record<string, unknown>>>;
      expect(data.worktrees.main.path).toBe('~/new-path');
      expect(data.worktrees.main.default).toBe(true);
    });
  });

  it('rejects an invalid value via schema', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'bad', title: 'B' }, ctxFor(root));
      await expect(
        setCmd.run(
          { slug: 'bad', field: 'state', value: 'garbage' },
          ctxFor(root),
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('throws NotFoundError when the slug is missing', async () => {
    await withEmptyActiveRoot(async (root) => {
      await expect(
        setCmd.run(
          { slug: 'nope', field: 'owner', value: 'x' },
          ctxFor(root),
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });
});

describe('touch', () => {
  it("stamps today's date", async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'tch', title: 'T' }, ctxFor(root));
      const briefPath = path.join(root, 'tch', 'brief.md');
      const before = await fs.readFile(briefPath, 'utf8');
      const stale = before.replace(/updated: .+/, 'updated: 2024-01-01');
      await fs.writeFile(briefPath, stale, 'utf8');

      const out = await touchCmd.run({ slug: 'tch' }, ctxFor(root));
      expect(out.updated).toBe(today());

      const parsed = matter(await fs.readFile(briefPath, 'utf8'));
      expect((parsed.data as Record<string, unknown>).updated).toBe(today());
    });
  });

  it('throws NotFoundError for missing slug', async () => {
    await withEmptyActiveRoot(async (root) => {
      await expect(touchCmd.run({ slug: 'no' }, ctxFor(root))).rejects.toThrow(
        NotFoundError,
      );
    });
  });
});

describe('paths', () => {
  it('returns the 6 expected paths', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'pth', title: 'P' }, ctxFor(root));
      const out = await pathsCmd.run({ slug: 'pth' }, ctxFor(root));
      const dir = path.join(root, 'pth');
      expect(out).toEqual({
        brief: path.join(dir, 'brief.md'),
        handoff: path.join(dir, 'handoff.md'),
        tasks_dir: path.join(dir, 'tasks'),
        sessions_dir: path.join(dir, 'sessions'),
        artifacts: path.join(dir, 'artifacts.yml'),
        sources_dir: path.join(dir, 'sources'),
      });
    });
  });

  it('throws NotFoundError for a missing slug', async () => {
    await withEmptyActiveRoot(async (root) => {
      await expect(pathsCmd.run({ slug: 'gone' }, ctxFor(root))).rejects.toThrow(
        NotFoundError,
      );
    });
  });
});

describe('rename', () => {
  it('moves the directory', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'old-name', title: 'O' }, ctxFor(root));
      const out = await renameCmd.run(
        { old_slug: 'old-name', new_slug: 'new-name' },
        ctxFor(root),
      );
      expect(out.from).toBe(path.join(root, 'old-name'));
      expect(out.to).toBe(path.join(root, 'new-name'));
      await expect(fs.stat(path.join(root, 'old-name'))).rejects.toThrow();
      expect((await fs.stat(path.join(root, 'new-name'))).isDirectory()).toBe(
        true,
      );
    });
  });

  it('refuses if the destination already exists', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'a-one', title: 'A' }, ctxFor(root));
      await newCmd.run({ slug: 'b-two', title: 'B' }, ctxFor(root));
      await expect(
        renameCmd.run(
          { old_slug: 'a-one', new_slug: 'b-two' },
          ctxFor(root),
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('refuses an invalid new slug', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'src', title: 'S' }, ctxFor(root));
      await expect(
        renameCmd.run(
          { old_slug: 'src', new_slug: 'Bad Name' },
          ctxFor(root),
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('throws NotFoundError when the source is missing', async () => {
    await withEmptyActiveRoot(async (root) => {
      await expect(
        renameCmd.run({ old_slug: 'ghost', new_slug: 'ghosted' }, ctxFor(root)),
      ).rejects.toThrow(NotFoundError);
    });
  });
});

describe('archive', () => {
  // archiveRoot is one level up from activeRoot. Tests share that parent, so
  // each archive test scrubs its own destination + uses a unique domain name.
  async function cleanArchive(root: string, domain: string): Promise<void> {
    const dest = path.join(path.resolve(root, '..'), domain);
    await fs.rm(dest, { recursive: true, force: true });
  }

  it('moves the dir under <archiveRoot>/<domain>/archive/<slug>-YYYY-MM', async () => {
    await withEmptyActiveRoot(async (root) => {
      const domain = 'arch-move';
      await cleanArchive(root, domain);
      try {
        await newCmd.run({ slug: 'shippable', title: 'S' }, ctxFor(root));
        const out = await archiveCmd.run({ slug: 'shippable', domain }, ctxFor(root));
        await expect(fs.stat(path.join(root, 'shippable'))).rejects.toThrow();
        expect((await fs.stat(out.to)).isDirectory()).toBe(true);

        const expectedRoot = path.join(path.resolve(root, '..'), domain, 'archive');
        expect(path.dirname(out.to)).toBe(expectedRoot);
        expect(path.basename(out.to)).toMatch(/^shippable-\d{4}-\d{2}$/);
      } finally {
        await cleanArchive(root, domain);
      }
    });
  });

  it('refuses when cwd is inside the source dir', async () => {
    await withEmptyActiveRoot(async (root) => {
      await newCmd.run({ slug: 'here', title: 'H' }, ctxFor(root));
      // process.chdir isn't allowed in vitest workers, so stub cwd instead.
      const fakeCwd = path.join(root, 'here', 'nested');
      const spy = vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
      try {
        await expect(
          archiveCmd.run({ slug: 'here', domain: 'arch-cwd' }, ctxFor(root)),
        ).rejects.toThrow(UsageError);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('refuses when the destination already exists', async () => {
    await withEmptyActiveRoot(async (root) => {
      const domain = 'arch-dup';
      await cleanArchive(root, domain);
      try {
        await newCmd.run({ slug: 'twice', title: 'T' }, ctxFor(root));
        const first = await archiveCmd.run({ slug: 'twice', domain }, ctxFor(root));
        expect((await fs.stat(first.to)).isDirectory()).toBe(true);

        // Recreate the source then try archiving again into the same YYYY-MM bucket.
        await newCmd.run({ slug: 'twice', title: 'T' }, ctxFor(root));
        await expect(
          archiveCmd.run({ slug: 'twice', domain }, ctxFor(root)),
        ).rejects.toThrow(ValidationError);
      } finally {
        await cleanArchive(root, domain);
      }
    });
  });

  it('throws NotFoundError when the slug is missing', async () => {
    await withEmptyActiveRoot(async (root) => {
      await expect(
        archiveCmd.run({ slug: 'absent', domain: 'arch-missing' }, ctxFor(root)),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
