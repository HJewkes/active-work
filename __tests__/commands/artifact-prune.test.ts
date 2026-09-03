import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';
import artifactPrune from '../../src/commands/artifact-prune.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/types.js';
import { BriefFrontmatterSchema } from '../../src/schemas/brief.js';
import { ArtifactsSchema, type Artifacts } from '../../src/schemas/artifacts.js';
import { resetRunners, setGitRunner, type CommandResult } from '../../src/utils/git-gh.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

const ok: CommandResult = { code: 0, stdout: 'true\n', stderr: '' };
const fail: CommandResult = { code: 128, stdout: '', stderr: 'fatal: not found' };

/**
 * A git that knows one branch and one worktree. Everything else is missing,
 * which is exactly the state prune has to tell apart from "cannot verify".
 */
function fakeGit(known: { branch: string; worktree: string }) {
  return async (_cmd: string, args: string[]): Promise<CommandResult> => {
    const cwd = args[args.indexOf('-C') + 1] ?? '';
    if (args.includes('--is-inside-work-tree')) return cwd === known.worktree ? ok : fail;
    if (args.includes('--verify')) return args.at(-1) === `refs/heads/${known.branch}` ? ok : fail;
    return fail;
  };
}

async function scaffold(activeRoot: string, slug: string, artifacts: Artifacts): Promise<string> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  const frontmatter = {
    schema_version: 1,
    title: slug,
    updated: '2026-09-03',
    state: 'backburner' as const,
    task_prefix: 'PR',
  };
  BriefFrontmatterSchema.parse(frontmatter);
  await fs.writeFile(path.join(dir, 'brief.md'), matter.stringify(`# ${slug}\n`, frontmatter));
  await fs.writeFile(
    path.join(dir, 'artifacts.yml'),
    YAML.stringify(ArtifactsSchema.parse(artifacts)),
  );
  return dir;
}

async function readArtifacts(dir: string): Promise<Artifacts> {
  return ArtifactsSchema.parse(
    YAML.parse(await fs.readFile(path.join(dir, 'artifacts.yml'), 'utf8')),
  );
}

describe('artifact.prune', () => {
  afterEach(() => resetRunners());

  it('reports a worktree whose path is gone and leaves artifacts.yml alone without --apply', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const repo = path.join(activeRoot, 'repo');
      await fs.mkdir(repo, { recursive: true });
      const live = path.join(activeRoot, 'wt-live');
      const stale = path.join(activeRoot, 'wt-stale');
      setGitRunner(fakeGit({ branch: 'main', worktree: live }));
      const dir = await scaffold(activeRoot, 'init', {
        branches: [{ repo, name: 'main' }],
        stashes: [],
        worktrees: [
          { path: live, repo, name: 'main', default: true },
          { path: stale, repo, branch: 'fix/old' },
        ],
      });

      const result = await artifactPrune.run({ slug: 'init' }, makeCtx(activeRoot));

      expect(result.applied).toBe(false);
      expect(result.pruned).toEqual([
        { kind: 'worktree', repo, name: stale, reason: 'worktree path missing' },
      ]);
      expect(result.kept_count).toBe(2);
      expect((await readArtifacts(dir)).worktrees).toHaveLength(2);
    });
  });

  it('removes missing branches and worktrees together with --apply', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const repo = path.join(activeRoot, 'repo');
      await fs.mkdir(repo, { recursive: true });
      const live = path.join(activeRoot, 'wt-live');
      setGitRunner(fakeGit({ branch: 'main', worktree: live }));
      const dir = await scaffold(activeRoot, 'init', {
        branches: [
          { repo, name: 'main' },
          { repo, name: 'feat/gone' },
        ],
        stashes: [],
        worktrees: [
          { path: live, repo, name: 'main', default: true },
          { path: path.join(activeRoot, 'wt-stale'), repo },
        ],
      });

      const result = await artifactPrune.run({ slug: 'init', apply: true }, makeCtx(activeRoot));

      expect(result.applied).toBe(true);
      expect(result.pruned.map((p) => `${p.kind}:${p.name}`)).toEqual([
        'branch:feat/gone',
        `worktree:${path.join(activeRoot, 'wt-stale')}`,
      ]);
      const after = await readArtifacts(dir);
      expect(after.branches).toEqual([{ repo, name: 'main' }]);
      expect(after.worktrees).toEqual([{ path: live, repo, name: 'main', default: true }]);
    });
  });

  it('keeps a worktree whose repo is not cloned on this machine', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const elsewhere = path.join(activeRoot, 'not-cloned-here');
      setGitRunner(fakeGit({ branch: 'main', worktree: 'none' }));
      await scaffold(activeRoot, 'init', {
        branches: [],
        stashes: [],
        worktrees: [{ path: path.join(elsewhere, 'wt'), repo: elsewhere }],
      });

      const result = await artifactPrune.run({ slug: 'init', apply: true }, makeCtx(activeRoot));

      expect(result.pruned).toEqual([]);
      expect(result.kept_count).toBe(1);
    });
  });
});
