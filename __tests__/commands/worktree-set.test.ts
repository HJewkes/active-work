import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';
import worktreeSet from '../../src/commands/worktree-set.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/types.js';
import { BriefFrontmatterSchema } from '../../src/schemas/brief.js';
import { ArtifactsSchema } from '../../src/schemas/artifacts.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

/**
 * Registered worktrees moved from `brief.worktrees` into `artifacts.yml` in v4
 * (AW-67). These helpers keep the label-keyed shape the assertions below are
 * written against, so they still describe behavior rather than storage.
 */
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
  };
  BriefFrontmatterSchema.parse(frontmatter);
  await fs.writeFile(path.join(dir, 'brief.md'), matter.stringify(`# ${slug}\n`, frontmatter));
  const entries = Object.entries(worktrees ?? {}).map(([name, entry]) => ({
    path: entry.path,
    repo: entry.path,
    name,
    ...(entry.default ? { default: true } : {}),
  }));
  await fs.writeFile(
    path.join(dir, 'artifacts.yml'),
    YAML.stringify(ArtifactsSchema.parse({ worktrees: entries })),
  );
}

async function readWorktrees(
  activeRoot: string,
  slug: string,
): Promise<Record<string, { path: string; default?: boolean }>> {
  const raw = await fs.readFile(path.join(activeRoot, slug, 'artifacts.yml'), 'utf8');
  const artifacts = ArtifactsSchema.parse(YAML.parse(raw));
  const out: Record<string, { path: string; default?: boolean }> = {};
  for (const entry of artifacts.worktrees) {
    if (entry.name === undefined) continue;
    out[entry.name] = {
      path: entry.path,
      ...(entry.default ? { default: true } : {}),
    };
  }
  return out;
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
        promoted: false,
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

  // Only possible once both records share a list (AW-67): naming a worktree
  // `wrap` already swept promotes that entry instead of adding a second record
  // of the same directory.
  it('promotes a swept worktree in place instead of duplicating it', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffold(activeRoot, 'swept');
      const file = path.join(activeRoot, 'swept', 'artifacts.yml');
      await fs.writeFile(
        file,
        YAML.stringify(
          ArtifactsSchema.parse({
            worktrees: [
              {
                path: '~/code/swept',
                repo: '~/code/sample',
                branch: 'feat/x',
                holding: 'half-done migration',
              },
            ],
          }),
        ),
      );

      const result = await run('swept', '~/code/swept', activeRoot);
      expect(result.promoted).toBe(true);

      const artifacts = ArtifactsSchema.parse(YAML.parse(await fs.readFile(file, 'utf8')));
      expect(artifacts.worktrees).toHaveLength(1);
      expect(artifacts.worktrees[0]).toMatchObject({
        path: '~/code/swept',
        // The swept context survives promotion rather than being overwritten.
        repo: '~/code/sample',
        branch: 'feat/x',
        holding: 'half-done migration',
        name: 'main',
        default: true,
      });
    });
  });
});
