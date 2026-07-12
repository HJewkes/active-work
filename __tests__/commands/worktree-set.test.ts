import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import worktreeSet from '../../src/commands/worktree-set.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/types.js';
import { BriefFrontmatterSchema } from '../../src/schemas/brief.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

async function scaffold(
  activeRoot: string,
  slug: string,
  worktrees?: Record<string, { path: string; default?: boolean }>,
): Promise<void> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  const frontmatter = {
    schema_version: 1,
    title: slug,
    updated: '2026-05-12',
    state: 'backburner' as const,
    task_prefix: 'WT',
    ...(worktrees ? { worktrees } : {}),
  };
  BriefFrontmatterSchema.parse(frontmatter);
  await fs.writeFile(
    path.join(dir, 'brief.md'),
    matter.stringify(`# ${slug}\n`, frontmatter),
  );
}

async function readWorktrees(
  activeRoot: string,
  slug: string,
): Promise<Record<string, { path: string; default?: boolean }>> {
  const raw = await fs.readFile(
    path.join(activeRoot, slug, 'brief.md'),
    'utf8',
  );
  return (matter(raw).data as {
    worktrees: Record<string, { path: string; default?: boolean }>;
  }).worktrees;
}

async function run(
  slug: string,
  wtPath: string,
  activeRoot: string,
  extra: { label?: string; default?: boolean } = {},
): Promise<{ slug: string; label: string; path: string; default: boolean }> {
  const parsed = worktreeSet.args.parse({ slug, path: wtPath, ...extra });
  return worktreeSet.run(parsed, makeCtx(activeRoot));
}

describe('worktree.set', () => {
  it('adds the first worktree as the default under the "main" label', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffold(activeRoot, 'fresh');
      const result = await run('fresh', '~/code/fresh', activeRoot);
      expect(result).toEqual({
        slug: 'fresh',
        label: 'main',
        path: '~/code/fresh',
        default: true,
      });
      const wt = await readWorktrees(activeRoot, 'fresh');
      expect(wt.main).toEqual({ path: '~/code/fresh', default: true });
    });
  });

  it('adds a second worktree as non-default and preserves the existing default', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffold(activeRoot, 'multi', {
        main: { path: '~/code/multi/main', default: true },
      });
      const result = await run('multi', '~/code/multi/spike', activeRoot, {
        label: 'spike',
      });
      expect(result.default).toBe(false);
      const wt = await readWorktrees(activeRoot, 'multi');
      expect(wt.main.default).toBe(true);
      expect(wt.spike).toEqual({ path: '~/code/multi/spike' });
    });
  });

  it('--default promotes the new worktree and clears default on the others', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffold(activeRoot, 'promote', {
        main: { path: '~/code/promote/main', default: true },
      });
      const result = await run('promote', '~/code/promote/spike', activeRoot, {
        label: 'spike',
        default: true,
      });
      expect(result.default).toBe(true);
      const wt = await readWorktrees(activeRoot, 'promote');
      expect(wt.spike.default).toBe(true);
      expect(wt.main.default).toBeUndefined();
    });
  });

  it('updating an existing default worktree keeps it default without --default', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffold(activeRoot, 'update', {
        main: { path: '~/code/update/old', default: true },
        spike: { path: '~/code/update/spike' },
      });
      const result = await run('update', '~/code/update/new', activeRoot);
      expect(result.default).toBe(true);
      const wt = await readWorktrees(activeRoot, 'update');
      expect(wt.main).toEqual({ path: '~/code/update/new', default: true });
      expect(wt.spike.default).toBeUndefined();
    });
  });
});
