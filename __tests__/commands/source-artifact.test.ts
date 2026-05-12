import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import sourceAddCmd, { slugifyLabel } from '../../src/commands/source-add.js';
import artifactAddPrCmd from '../../src/commands/artifact-add-pr.js';
import artifactAddBranchCmd from '../../src/commands/artifact-add-branch.js';
import artifactAddStashCmd from '../../src/commands/artifact-add-stash.js';
import artifactListCmd from '../../src/commands/artifact-list.js';
import artifactCheckCmd, {
  mapGhState,
  resetGhFetcher,
  setGhFetcher,
} from '../../src/commands/artifact-check.js';
import { ArtifactsSchema } from '../../src/schemas/artifacts.js';
import { readYaml } from '../../src/utils/yaml-io.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

const ctx = { activeRoot: '', warnings: [], format: 'json' as const };

function initiativeDir(root: string): string {
  return path.join(root, SLUG);
}

async function readArtifacts(root: string): Promise<ReturnType<typeof readYaml>> {
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

describe('artifact.add-pr', () => {
  it('appends a new PR', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await artifactAddPrCmd.run(
        {
          slug: SLUG,
          number: 100,
          repo: 'HJewkes/other',
          title: 'Another PR',
        },
        ctx,
      );
      expect(res.pr.status).toBe('open');
      const data = await readArtifacts(root);
      expect(data.prs).toHaveLength(2);
      const target = data.prs.find((p) => p.number === 100);
      expect(target?.repo).toBe('HJewkes/other');
      expect(target?.last_checked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('upserts an existing PR by (repo, number)', async () => {
    await withTempActiveRoot(async (root) => {
      await artifactAddPrCmd.run(
        {
          slug: SLUG,
          number: 42,
          repo: 'HJewkes/sample',
          title: 'Updated Title',
          status: 'merged',
        },
        ctx,
      );
      const data = await readArtifacts(root);
      expect(data.prs).toHaveLength(1);
      expect(data.prs[0]!.title).toBe('Updated Title');
      expect(data.prs[0]!.status).toBe('merged');
    });
  });
});

describe('artifact.add-branch', () => {
  it('upserts by (repo, name)', async () => {
    await withTempActiveRoot(async (root) => {
      await artifactAddBranchCmd.run(
        {
          slug: SLUG,
          repo: '~/code/sample',
          name: 'feat/sample',
          last_commit: '2026-05-12',
        },
        ctx,
      );
      const data = await readArtifacts(root);
      expect(data.branches).toHaveLength(1);
      expect(data.branches[0]!.last_commit).toBe('2026-05-12');

      await artifactAddBranchCmd.run(
        {
          slug: SLUG,
          repo: '~/code/sample',
          name: 'feat/another',
        },
        ctx,
      );
      const after = await readArtifacts(root);
      expect(after.branches).toHaveLength(2);
    });
  });
});

describe('artifact.add-stash', () => {
  it('appends and allows duplicates', async () => {
    await withTempActiveRoot(async (root) => {
      await artifactAddStashCmd.run(
        { slug: SLUG, repo: '~/code/sample', message: 'WIP' },
        ctx,
      );
      await artifactAddStashCmd.run(
        { slug: SLUG, repo: '~/code/sample', message: 'WIP' },
        ctx,
      );
      const data = await readArtifacts(root);
      expect(data.stashes).toHaveLength(2);
      expect(data.stashes.every((s) => s.message === 'WIP')).toBe(true);
    });
  });
});

describe('artifact.list', () => {
  it('returns one slug when called with slug', async () => {
    await withTempActiveRoot(async () => {
      const res = await artifactListCmd.run({ slug: SLUG }, ctx);
      expect(res.items).toHaveLength(1);
      expect(res.items[0]!.slug).toBe(SLUG);
      expect(res.items[0]!.artifacts.prs).toHaveLength(1);
    });
  });

  it('returns every initiative when --all-initiatives', async () => {
    await withTempActiveRoot(async (root) => {
      const secondSlug = 'second-initiative';
      const secondDir = path.join(root, secondSlug);
      await fs.mkdir(secondDir, { recursive: true });
      await fs.writeFile(
        path.join(secondDir, 'artifacts.yml'),
        'prs: []\nbranches: []\nstashes: []\n',
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

describe('mapGhState', () => {
  it('maps known states', () => {
    expect(mapGhState('OPEN')).toBe('open');
    expect(mapGhState('MERGED')).toBe('merged');
    expect(mapGhState('CLOSED')).toBe('closed');
  });

  it('throws on unknown state', () => {
    expect(() => mapGhState('DRAFT')).toThrow(/Unknown gh PR state/);
  });
});

describe('artifact.check', () => {
  afterEach(() => {
    resetGhFetcher();
  });

  it('refreshes PR statuses and stamps last_checked', async () => {
    await withTempActiveRoot(async (root) => {
      setGhFetcher(async () => ({ state: 'MERGED' }));
      const before = await readArtifacts(root);
      const beforeStamp = before.prs[0]!.last_checked;

      const res = await artifactCheckCmd.run({ slug: SLUG }, ctx);
      expect(res.updated).toHaveLength(1);
      expect(res.updated[0]!.status).toBe('merged');
      expect(res.updated[0]!.status_changed).toBe(true);
      expect(res.errors).toHaveLength(0);

      const after = await readArtifacts(root);
      expect(after.prs[0]!.status).toBe('merged');
      expect(after.prs[0]!.last_checked).not.toBe(beforeStamp);
    });
  });

  it('reports status_changed=false when state unchanged', async () => {
    await withTempActiveRoot(async () => {
      setGhFetcher(async () => ({ state: 'OPEN' }));
      const res = await artifactCheckCmd.run({ slug: SLUG }, ctx);
      expect(res.updated[0]!.status_changed).toBe(false);
    });
  });

  it('captures per-PR errors when gh fetch fails', async () => {
    await withTempActiveRoot(async (root) => {
      setGhFetcher(async () => {
        throw new Error('gh not found');
      });
      const res = await artifactCheckCmd.run({ slug: SLUG }, ctx);
      expect(res.updated).toHaveLength(0);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]!.error).toMatch(/gh not found/);
      // Still writes the file (which keeps existing prs intact).
      const after = await readArtifacts(root);
      expect(after.prs).toHaveLength(1);
    });
  });
});

describe('command metadata', () => {
  it('source.add positional and required option flags', () => {
    expect(sourceAddCmd.name).toBe('source.add');
    expect(sourceAddCmd.cli?.positional).toEqual(['slug', 'file']);
    expect(sourceAddCmd.cli?.options?.type?.required).toBe(true);
  });

  it('artifact command names are namespaced', () => {
    expect(artifactAddPrCmd.name).toBe('artifact.add-pr');
    expect(artifactAddBranchCmd.name).toBe('artifact.add-branch');
    expect(artifactAddStashCmd.name).toBe('artifact.add-stash');
    expect(artifactListCmd.name).toBe('artifact.list');
    expect(artifactCheckCmd.name).toBe('artifact.check');
  });
});

// Silence unused warning for beforeEach if not used; vitest still imports it.
beforeEach(() => {});
