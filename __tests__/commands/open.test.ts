import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import openCommand from '../../src/commands/open.js';
import { NotFoundError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

function makeCtx(activeRoot: string, cwd?: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', cwd };
}

interface OpenSuccess {
  slug: string;
  prompt: string;
  cwd_hint: string;
  resolved_from?: 'slug' | 'cwd';
  metadata: {
    slug: string;
    brief_title: string;
    open_task_count: number;
  };
}

interface PickerResult {
  picker: true;
  initiatives: Array<{
    slug: string;
    title: string;
    state: 'focused' | 'backburner' | 'paused' | 'done';
    rank?: number;
  }>;
}

function isPicker(value: unknown): value is PickerResult {
  return typeof value === 'object' && value !== null && 'picker' in value;
}

async function makeInitiativeWithWorktree(
  activeRoot: string,
  slug: string,
  title: string,
  taskPrefix: string,
  worktreePath: string,
): Promise<void> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'brief.md'),
    [
      '---',
      'schema_version: 1',
      `title: ${title}`,
      'updated: 2026-05-12',
      'state: backburner',
      `task_prefix: ${taskPrefix}`,
      'worktrees:',
      '  main:',
      `    path: ${worktreePath}`,
      '---',
      '',
      `# ${title}`,
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(dir, 'artifacts.yml'),
    'branches: []\nstashes: []\n',
  );
}

describe('open command', () => {
  it('with slug returns prompt, cwd_hint, and metadata', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { slug: 'sample-initiative', offline: true },
        makeCtx(activeRoot),
      );
      expect(isPicker(out)).toBe(false);
      const result = out as OpenSuccess;
      expect(result.slug).toBe('sample-initiative');
      expect(result.prompt).toContain('Sample Initiative');
      expect(result.cwd_hint).toBe(path.join(os.homedir(), 'code/sample'));
      expect(result.metadata.brief_title).toBe('Sample Initiative');
      expect(result.metadata.open_task_count).toBe(1);
    });
  });

  it('with no slug returns picker:true and the initiative list', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run({}, makeCtx(activeRoot));
      expect(isPicker(out)).toBe(true);
      const picker = out as PickerResult;
      expect(picker.initiatives).toEqual([
        {
          slug: 'sample-initiative',
          title: 'Sample Initiative',
          state: 'focused',
          rank: 1,
        },
      ]);
    });
  });

  it('with no slug resolves the initiative whose worktree contains the cwd', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { cwd: path.join(os.homedir(), 'code/sample'), offline: true },
        makeCtx(activeRoot),
      );
      expect(isPicker(out)).toBe(false);
      const result = out as OpenSuccess;
      expect(result.slug).toBe('sample-initiative');
      expect(result.resolved_from).toBe('cwd');
      // The launch dir is the matched worktree, not the brief default.
      expect(result.cwd_hint).toBe(path.join(os.homedir(), 'code/sample'));
    });
  });

  it('resolves from the context cwd when no cwd arg is given', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { offline: true },
        makeCtx(activeRoot, path.join(os.homedir(), 'code/sample/src')),
      );
      const result = out as OpenSuccess;
      expect(result.slug).toBe('sample-initiative');
      expect(result.resolved_from).toBe('cwd');
    });
  });

  it('returns the picker when no cwd is available anywhere (daemon path)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // No cwd arg and no ctx.cwd — the resolution is skipped entirely.
      const out = await openCommand.run({ offline: true }, makeCtx(activeRoot));
      expect(isPicker(out)).toBe(true);
    });
  });

  it('resolves from a nested subdirectory of a worktree', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { cwd: path.join(os.homedir(), 'code/sample/src/deep/nested'), offline: true },
        makeCtx(activeRoot),
      );
      const result = out as OpenSuccess;
      expect(result.slug).toBe('sample-initiative');
      expect(result.resolved_from).toBe('cwd');
    });
  });

  it('matches through symlinks by canonicalizing both sides', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // Real worktree dir + a symlink pointing at it. The brief stores the
      // real path; the caller's cwd arrives through the symlink.
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-symlink-'));
      const realWork = path.join(base, 'real-checkout');
      const linkWork = path.join(base, 'linked-checkout');
      await fs.mkdir(path.join(realWork, 'src'), { recursive: true });
      await fs.symlink(realWork, linkWork);
      try {
        const dir = path.join(activeRoot, 'linked-init');
        await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
        await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
        await fs.writeFile(
          path.join(dir, 'brief.md'),
          [
            '---',
            'schema_version: 1',
            'title: Linked Init',
            'updated: 2026-05-12',
            'state: backburner',
            'task_prefix: LI',
            'worktrees:',
            '  main:',
            `    path: ${realWork}`,
            '---',
            '',
            '# Linked Init',
            '',
          ].join('\n'),
        );
        await fs.writeFile(
          path.join(dir, 'artifacts.yml'),
          'branches: []\nstashes: []\n',
        );

        const out = await openCommand.run(
          { cwd: path.join(linkWork, 'src'), offline: true },
          makeCtx(activeRoot),
        );
        const result = out as OpenSuccess;
        expect(result.slug).toBe('linked-init');
        expect(result.resolved_from).toBe('cwd');
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    });
  });

  it('falls back to the picker when the cwd matches no worktree', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { cwd: path.join(os.homedir(), 'code/unrelated-project'), offline: true },
        makeCtx(activeRoot),
      );
      expect(isPicker(out)).toBe(true);
    });
  });

  it('--pick forces the picker even when the cwd matches a worktree', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { cwd: path.join(os.homedir(), 'code/sample'), pick: true, offline: true },
        makeCtx(activeRoot),
      );
      expect(isPicker(out)).toBe(true);
    });
  });

  it('--adhoc reframes the bootstrap prompt', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { slug: 'sample-initiative', adhoc: true, offline: true },
        makeCtx(activeRoot),
      );
      const result = out as OpenSuccess;
      expect(result.prompt).toContain('ad-hoc session');
      expect(result.prompt).not.toContain('Work the top task unless redirected.');
    });
  });

  it('an explicit slug is tagged resolved_from "slug"', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { slug: 'sample-initiative', offline: true },
        makeCtx(activeRoot),
      );
      const result = out as OpenSuccess;
      expect(result.resolved_from).toBe('slug');
    });
  });

  it('picks the deepest worktree when cwd is inside nested worktrees', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await makeInitiativeWithWorktree(activeRoot, 'mono-outer', 'Mono Outer', 'MO', '~/code/mono');
      await makeInitiativeWithWorktree(
        activeRoot,
        'mono-inner',
        'Mono Inner',
        'MI',
        '~/code/mono/packages/app',
      );
      const out = await openCommand.run(
        { cwd: path.join(os.homedir(), 'code/mono/packages/app/src'), offline: true },
        makeCtx(activeRoot),
      );
      const result = out as OpenSuccess;
      expect(result.slug).toBe('mono-inner');
    });
  });

  it('falls back to the picker when two initiatives claim the same worktree', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await makeInitiativeWithWorktree(activeRoot, 'twin-a', 'Twin A', 'TA', '~/code/shared');
      await makeInitiativeWithWorktree(activeRoot, 'twin-b', 'Twin B', 'TB', '~/code/shared');
      const out = await openCommand.run(
        { cwd: path.join(os.homedir(), 'code/shared'), offline: true },
        makeCtx(activeRoot),
      );
      expect(isPicker(out)).toBe(true);
    });
  });

  it('sorts picker results: focused-by-rank, then backburner, then paused, then done', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // Scaffold extra initiatives so we can verify ordering.
      const make = async (
        slug: string,
        title: string,
        body: string,
      ): Promise<void> => {
        const dir = path.join(activeRoot, slug);
        await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
        await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
        await fs.writeFile(
          path.join(dir, 'brief.md'),
          `---\n${body}\n---\n\n# ${title}\n`,
        );
        await fs.writeFile(
          path.join(dir, 'artifacts.yml'),
          'branches: []\nstashes: []\n',
        );
      };
      await make(
        'b-second-focused',
        'Second focused',
        [
          'schema_version: 1',
          'title: Second focused',
          'updated: 2026-05-12',
          'state: focused',
          'rank: 2',
          'task_prefix: SF',
        ].join('\n'),
      );
      await make(
        'c-paused',
        'Paused',
        [
          'schema_version: 1',
          'title: Paused',
          'updated: 2026-05-12',
          'state: paused',
          'paused_since: 2026-05-01',
          'restart_trigger: stabilizes',
          'task_prefix: PA',
        ].join('\n'),
      );
      await make(
        'a-backburner',
        'Backburner',
        [
          'schema_version: 1',
          'title: Backburner',
          'updated: 2026-05-12',
          'state: backburner',
          'task_prefix: BB',
        ].join('\n'),
      );

      const out = await openCommand.run({}, makeCtx(activeRoot));
      const picker = out as PickerResult;
      const order = picker.initiatives.map((i) => i.slug);
      expect(order).toEqual([
        'sample-initiative',
        'b-second-focused',
        'a-backburner',
        'c-paused',
      ]);
    });
  });

  it('throws NotFoundError for an unknown slug, listing known slugs', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        openCommand.run({ slug: 'no-such-thing' }, makeCtx(activeRoot)),
      ).rejects.toThrow(NotFoundError);
      await expect(
        openCommand.run({ slug: 'no-such-thing' }, makeCtx(activeRoot)),
      ).rejects.toThrow(/sample-initiative/);
    });
  });

  it('resolves a unique prefix to the full slug', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await openCommand.run(
        { slug: 'sample', offline: true },
        makeCtx(activeRoot),
      );
      const result = out as OpenSuccess;
      expect(result.slug).toBe('sample-initiative');
    });
  });

  it('throws on ambiguous prefix with candidate list', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // Create a sibling whose name shares a prefix with sample-initiative.
      const dir = path.join(activeRoot, 'sample-sibling');
      await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
      await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'brief.md'),
        [
          '---',
          'schema_version: 1',
          'title: Sample Sibling',
          'updated: 2026-05-12',
          'state: backburner',
          'task_prefix: SS',
          '---',
          '',
          '# Sample Sibling',
          '',
        ].join('\n'),
      );
      await fs.writeFile(
        path.join(dir, 'artifacts.yml'),
        'branches: []\nstashes: []\n',
      );

      await expect(
        openCommand.run({ slug: 'sample-' }, makeCtx(activeRoot)),
      ).rejects.toThrow(/Ambiguous slug 'sample-'/);
      await expect(
        openCommand.run({ slug: 'sample-' }, makeCtx(activeRoot)),
      ).rejects.toThrow(/sample-initiative.*sample-sibling/);
    });
  });
});
