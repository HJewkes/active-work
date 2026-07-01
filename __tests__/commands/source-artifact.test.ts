import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import sourceAddCmd, { slugifyLabel } from '../../src/commands/source-add.js';
import artifactAddBranchCmd from '../../src/commands/artifact-add-branch.js';
import artifactAddStashCmd from '../../src/commands/artifact-add-stash.js';
import artifactListCmd from '../../src/commands/artifact-list.js';
import artifactNoteCmd from '../../src/commands/artifact-note.js';
import artifactPruneCmd from '../../src/commands/artifact-prune.js';
import artifactStatusCmd from '../../src/commands/artifact-status.js';
import {
  resetRunners,
  setGitRunner,
  setGhRunner,
  type CommandRunner,
} from '../../src/utils/git-gh.js';
import { ArtifactsSchema } from '../../src/schemas/artifacts.js';
import { readYaml } from '../../src/utils/yaml-io.js';
import { UsageError } from '../../src/errors.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

const ctx = { activeRoot: '', warnings: [], format: 'json' as const };

function initiativeDir(root: string): string {
  return path.join(root, SLUG);
}

async function readArtifacts(
  root: string,
): Promise<ReturnType<typeof readYaml<typeof ArtifactsSchema._type>>> {
  return readYaml(path.join(initiativeDir(root), 'artifacts.yml'), ArtifactsSchema);
}

async function writeSource(root: string, name: string, body = 'hello'): Promise<string> {
  const inbox = path.join(root, '_inbox');
  await fs.mkdir(inbox, { recursive: true });
  const filePath = path.join(inbox, name);
  await fs.writeFile(filePath, body, 'utf8');
  return filePath;
}

describe('slugifyLabel', () => {
  it('lowercases and replaces non-alphanumerics with dashes', () => {
    expect(slugifyLabel('Hello World!')).toBe('hello-world');
  });

  it('collapses runs of dashes', () => {
    expect(slugifyLabel('foo___bar??baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyLabel('--abc--')).toBe('abc');
  });

  it('falls back to untitled when empty', () => {
    expect(slugifyLabel('!!!')).toBe('untitled');
    expect(slugifyLabel('')).toBe('untitled');
  });
});

describe('source.add', () => {
  it('moves a PR source with canonical filename', async () => {
    await withTempActiveRoot(async (root) => {
      const src = await writeSource(root, 'raw.md');
      const res = await sourceAddCmd.run(
        {
          slug: SLUG,
          file: src,
          type: 'pr',
          label: 'Fix Big Bug',
          pr_number: 123,
        },
        ctx,
      );
      const expected = path.join(initiativeDir(root), 'sources', 'pr-123-fix-big-bug.md');
      expect(res.moved_to).toBe(expected);
      expect(await fs.readFile(expected, 'utf8')).toBe('hello');
      await expect(fs.access(src)).rejects.toThrow();
    });
  });

  it('moves a deepdive source with canonical filename', async () => {
    await withTempActiveRoot(async (root) => {
      const src = await writeSource(root, 'dd.md');
      const res = await sourceAddCmd.run(
        { slug: SLUG, file: src, type: 'deepdive', topic: 'Caching Strategy' },
        ctx,
      );
      expect(res.moved_to).toBe(
        path.join(initiativeDir(root), 'sources', 'deepdive-caching-strategy.md'),
      );
    });
  });

  it('moves a session source using provided date', async () => {
    await withTempActiveRoot(async (root) => {
      const src = await writeSource(root, 's.md');
      const res = await sourceAddCmd.run(
        {
          slug: SLUG,
          file: src,
          type: 'session',
          label: 'Kickoff',
          date: '2026-04-01',
        },
        ctx,
      );
      expect(res.moved_to).toBe(
        path.join(initiativeDir(root), 'sources', '2026-04-01-kickoff.md'),
      );
    });
  });

  it('moves a pointer source using slugified label', async () => {
    await withTempActiveRoot(async (root) => {
      const src = await writeSource(root, 'p.md');
      const res = await sourceAddCmd.run(
        { slug: SLUG, file: src, type: 'pointer', label: 'Design Doc' },
        ctx,
      );
      expect(res.moved_to).toBe(
        path.join(initiativeDir(root), 'sources', 'design-doc.md'),
      );
    });
  });

  it('throws on collision without force', async () => {
    await withTempActiveRoot(async (root) => {
      const src1 = await writeSource(root, 'a.md', 'first');
      await sourceAddCmd.run(
        { slug: SLUG, file: src1, type: 'pointer', label: 'Doc' },
        ctx,
      );
      const src2 = await writeSource(root, 'b.md', 'second');
      await expect(
        sourceAddCmd.run(
          { slug: SLUG, file: src2, type: 'pointer', label: 'Doc' },
          ctx,
        ),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('overwrites on collision with force', async () => {
    await withTempActiveRoot(async (root) => {
      const src1 = await writeSource(root, 'a.md', 'first');
      const res1 = await sourceAddCmd.run(
        { slug: SLUG, file: src1, type: 'pointer', label: 'Doc' },
        ctx,
      );
      const src2 = await writeSource(root, 'b.md', 'second');
      const res2 = await sourceAddCmd.run(
        { slug: SLUG, file: src2, type: 'pointer', label: 'Doc', force: true },
        ctx,
      );
      expect(res2.moved_to).toBe(res1.moved_to);
      expect(await fs.readFile(res2.moved_to, 'utf8')).toBe('second');
    });
  });

  it('returns noop when source already at canonical target', async () => {
    await withTempActiveRoot(async (root) => {
      const sourcesDir = path.join(initiativeDir(root), 'sources');
      await fs.mkdir(sourcesDir, { recursive: true });
      const target = path.join(sourcesDir, 'design-doc.md');
      await fs.writeFile(target, 'in-place', 'utf8');
      const res = await sourceAddCmd.run(
        { slug: SLUG, file: target, type: 'pointer', label: 'Design Doc' },
        ctx,
      );
      expect(res.noop).toBe(true);
      expect(res.moved_to).toBe(target);
      expect(await fs.readFile(target, 'utf8')).toBe('in-place');
    });
  });

  it('throws NotFoundError when source file is missing', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        sourceAddCmd.run(
          {
            slug: SLUG,
            file: path.join(root, 'does-not-exist.md'),
            type: 'pointer',
            label: 'x',
          },
          ctx,
        ),
      ).rejects.toThrow(/source file not found/);
    });
  });

  it('throws ValidationError when required type fields are missing', async () => {
    await withTempActiveRoot(async (root) => {
      const src = await writeSource(root, 'x.md');
      await expect(
        sourceAddCmd.run({ slug: SLUG, file: src, type: 'pr', label: 'no-num' }, ctx),
      ).rejects.toThrow(/requires --pr-number/);
    });
  });
});

describe('artifact.add-branch', () => {
  it('upserts by (repo, name) and accepts an optional note', async () => {
    await withTempActiveRoot(async (root) => {
      await artifactAddBranchCmd.run(
        {
          slug: SLUG,
          repo: '~/code/sample',
          name: 'feat/sample',
          note: 'rewritten note',
        },
        ctx,
      );
      const data = await readArtifacts(root);
      expect(data.branches).toHaveLength(1);
      expect(data.branches[0]!.note).toBe('rewritten note');

      await artifactAddBranchCmd.run(
        { slug: SLUG, repo: '~/code/sample', name: 'feat/another' },
        ctx,
      );
      const after = await readArtifacts(root);
      expect(after.branches).toHaveLength(2);
    });
  });

  it('preserves an existing note when re-adding the same branch without --note', async () => {
    await withTempActiveRoot(async (root) => {
      await artifactAddBranchCmd.run(
        { slug: SLUG, repo: '~/code/sample', name: 'feat/sample' },
        ctx,
      );
      const data = await readArtifacts(root);
      expect(data.branches[0]!.note).toBe('scaffolding for sample initiative');
    });
  });
});

describe('artifact.add-stash', () => {
  it('appends with label and allows duplicates', async () => {
    await withTempActiveRoot(async (root) => {
      await artifactAddStashCmd.run(
        { slug: SLUG, repo: '~/code/sample', label: 'WIP' },
        ctx,
      );
      await artifactAddStashCmd.run(
        { slug: SLUG, repo: '~/code/sample', label: 'WIP', sha: 'abc123' },
        ctx,
      );
      const data = await readArtifacts(root);
      expect(data.stashes).toHaveLength(2);
      expect(data.stashes.every((s) => s.label === 'WIP')).toBe(true);
      expect(data.stashes[1]!.sha).toBe('abc123');
    });
  });
});

describe('artifact.list', () => {
  it('returns one slug when called with slug', async () => {
    await withTempActiveRoot(async () => {
      const res = await artifactListCmd.run({ slug: SLUG }, ctx);
      expect(res.items).toHaveLength(1);
      expect(res.items[0]!.slug).toBe(SLUG);
      expect(res.items[0]!.artifacts.branches).toHaveLength(1);
    });
  });

  it('returns every initiative when --all-initiatives', async () => {
    await withTempActiveRoot(async (root) => {
      const secondSlug = 'second-initiative';
      const secondDir = path.join(root, secondSlug);
      await fs.mkdir(secondDir, { recursive: true });
      await fs.writeFile(
        path.join(secondDir, 'artifacts.yml'),
        'branches: []\nstashes: []\n',
        'utf8',
      );
      const res = await artifactListCmd.run({ all_initiatives: true }, ctx);
      const slugs = res.items.map((i) => i.slug).sort();
      expect(slugs).toEqual([SLUG, secondSlug].sort());
    });
  });

  it('throws UsageError without slug or --all-initiatives', async () => {
    await withTempActiveRoot(async () => {
      await expect(artifactListCmd.run({}, ctx)).rejects.toThrow(/requires/);
    });
  });
});

describe('artifact.note', () => {
  it('updates the note on an existing branch', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await artifactNoteCmd.run(
        {
          slug: SLUG,
          repo: '~/code/sample',
          name: 'feat/sample',
          note: 'updated context',
        },
        ctx,
      );
      expect(res.branch.note).toBe('updated context');
      const data = await readArtifacts(root);
      expect(data.branches[0]!.note).toBe('updated context');
    });
  });

  it('throws UsageError when the branch is untracked', async () => {
    await withTempActiveRoot(async () => {
      await expect(
        artifactNoteCmd.run(
          {
            slug: SLUG,
            repo: '~/code/sample',
            name: 'feat/does-not-exist',
            note: 'x',
          },
          ctx,
        ),
      ).rejects.toBeInstanceOf(UsageError);
    });
  });
});

describe('artifact.status', () => {
  afterEach(() => {
    resetRunners();
  });

  it('reports present + ahead/behind + PR for live branches', async () => {
    await withTempActiveRoot(async () => {
      const gitRunner: CommandRunner = async (_bin, args) => {
        if (args.includes('rev-parse') && args.includes('--verify')) {
          return { code: 0, stdout: 'deadbeef\n', stderr: '' };
        }
        if (args.includes('log')) {
          return { code: 0, stdout: '2026-05-12T10:00:00+00:00\n', stderr: '' };
        }
        if (args.includes('rev-list')) {
          return { code: 0, stdout: '1\t4\n', stderr: '' };
        }
        if (args.includes('remote') && args.includes('get-url')) {
          return {
            code: 0,
            stdout: 'git@github.com:HJewkes/sample.git\n',
            stderr: '',
          };
        }
        return { code: 1, stdout: '', stderr: 'unhandled' };
      };
      const ghRunner: CommandRunner = async () => ({
        code: 0,
        stdout: JSON.stringify([
          {
            number: 17,
            state: 'OPEN',
            title: 'Sample PR',
            url: 'https://github.com/HJewkes/sample/pull/17',
            statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }],
          },
        ]),
        stderr: '',
      });
      setGitRunner(gitRunner);
      setGhRunner(ghRunner);
      const res = await artifactStatusCmd.run({ slug: SLUG }, ctx);
      expect(res.branches).toHaveLength(1);
      const b = res.branches[0]!;
      expect(b.present).toBe(true);
      expect(b.ahead).toBe(4);
      expect(b.behind).toBe(1);
      expect(b.pr?.number).toBe(17);
      expect(b.pr?.checks).toMatch(/pass/);
    });
  });

  it('captures per-branch errors without throwing', async () => {
    await withTempActiveRoot(async () => {
      const failing: CommandRunner = async () => ({
        code: 1,
        stdout: '',
        stderr: 'boom',
      });
      setGitRunner(failing);
      setGhRunner(failing);
      const res = await artifactStatusCmd.run({ slug: SLUG }, ctx);
      expect(res.branches).toHaveLength(1);
      expect(res.branches[0]!.present).toBe(false);
      expect(res.branches[0]!.pr).toBeNull();
    });
  });
});

describe('artifact.prune', () => {
  afterEach(() => {
    resetRunners();
  });

  it('lists pruning candidates as a dry-run by default and does not write', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(async () => ({ code: 1, stdout: '', stderr: 'no such ref' }));
      const before = await readArtifacts(root);
      const res = await artifactPruneCmd.run({ slug: SLUG }, ctx);
      expect(res.applied).toBe(false);
      expect(res.pruned).toHaveLength(1);
      expect(res.pruned[0]!.name).toBe('feat/sample');
      const after = await readArtifacts(root);
      expect(after.branches.length).toBe(before.branches.length);
    });
  });

  it('removes missing branches when --apply', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(async () => ({ code: 1, stdout: '', stderr: 'no such ref' }));
      const res = await artifactPruneCmd.run({ slug: SLUG, apply: true }, ctx);
      expect(res.applied).toBe(true);
      expect(res.pruned).toHaveLength(1);
      const after = await readArtifacts(root);
      expect(after.branches).toHaveLength(0);
    });
  });

  it('keeps branches that exist', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(async () => ({ code: 0, stdout: 'deadbeef\n', stderr: '' }));
      const res = await artifactPruneCmd.run({ slug: SLUG, apply: true }, ctx);
      expect(res.applied).toBe(false);
      expect(res.pruned).toHaveLength(0);
      const after = await readArtifacts(root);
      expect(after.branches).toHaveLength(1);
    });
  });
});

describe('command metadata', () => {
  it('source.add positional and required option flags', () => {
    expect(sourceAddCmd.name).toBe('source.add');
    expect(sourceAddCmd.cli?.positional).toEqual(['slug', 'file']);
    expect(sourceAddCmd.cli?.options?.type?.required).toBe(true);
  });

  it('artifact CRUD command names are namespaced', () => {
    expect(artifactAddBranchCmd.name).toBe('artifact.add-branch');
    expect(artifactAddStashCmd.name).toBe('artifact.add-stash');
    expect(artifactListCmd.name).toBe('artifact.list');
    expect(artifactStatusCmd.name).toBe('artifact.status');
    expect(artifactPruneCmd.name).toBe('artifact.prune');
    expect(artifactNoteCmd.name).toBe('artifact.note');
  });
});

beforeEach(() => {});
