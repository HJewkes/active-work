import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { v3ToV4Worktrees } from '../../src/migrations/v3-to-v4-worktrees.js';
import { ArtifactsSchema } from '../../src/schemas/artifacts.js';

let activeRoot: string;

beforeEach(() => {
  activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-mig-v4-'));
});

afterEach(() => {
  rmSync(activeRoot, { recursive: true, force: true });
});

async function writeInitiative(
  slug: string,
  frontmatter: string,
  artifacts?: string,
  body = `# ${slug}\n\nSome prose.\n`,
): Promise<string> {
  const dir = path.join(activeRoot, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'brief.md'), `---\n${frontmatter}---\n\n${body}`, 'utf8');
  if (artifacts !== undefined) {
    await writeFile(path.join(dir, 'artifacts.yml'), artifacts, 'utf8');
  }
  return dir;
}

const BASE = [
  'schema_version: 1',
  'title: Sample',
  'updated: 2026-05-12',
  'state: backburner',
  'task_prefix: SA',
  '',
].join('\n');

async function readArtifacts(dir: string) {
  return ArtifactsSchema.parse(YAML.parse(await readFile(path.join(dir, 'artifacts.yml'), 'utf8')));
}

async function readBriefData(dir: string): Promise<Record<string, unknown>> {
  return matter(await readFile(path.join(dir, 'brief.md'), 'utf8')).data as Record<string, unknown>;
}

describe('v3 -> v4 worktrees', () => {
  it('moves brief.worktrees into artifacts.yml as named entries', async () => {
    const dir = await writeInitiative(
      'sample',
      BASE +
        ['worktrees:', '  main:', '    path: ~/code/sample', '    default: true', ''].join('\n'),
      'branches: []\nstashes: []\n',
    );

    await v3ToV4Worktrees.run(activeRoot);

    expect(await readArtifacts(dir)).toMatchObject({
      worktrees: [{ path: '~/code/sample', repo: '~/code/sample', name: 'main', default: true }],
    });
    expect(await readBriefData(dir)).not.toHaveProperty('worktrees');
  });

  it('preserves the brief body byte-for-byte', async () => {
    const body = '# Sample\n\nProse with `code` and a list:\n\n- one\n- two\n';
    const dir = await writeInitiative(
      'prose',
      BASE + ['worktrees:', '  main:', '    path: ~/code/prose', ''].join('\n'),
      'branches: []\nstashes: []\n',
      body,
    );

    await v3ToV4Worktrees.run(activeRoot);

    const raw = await readFile(path.join(dir, 'brief.md'), 'utf8');
    expect(matter(raw).content.trim()).toBe(body.trim());
  });

  // A wrap that ran before the migration already swept the directory. Adding a
  // second record of it would double-count the worktree and, worse, leave the
  // swept context (branch, holding) stranded on the unnamed copy.
  it('promotes a swept entry at the same path instead of duplicating it', async () => {
    const dir = await writeInitiative(
      'swept',
      BASE +
        ['worktrees:', '  main:', '    path: ~/code/swept', '    default: true', ''].join('\n'),
      [
        'branches: []',
        'stashes: []',
        'worktrees:',
        '  - path: ~/code/swept',
        '    repo: acme/swept',
        '    branch: feat/x',
        '    holding: half-done migration',
        '',
      ].join('\n'),
    );

    await v3ToV4Worktrees.run(activeRoot);

    const artifacts = await readArtifacts(dir);
    expect(artifacts.worktrees).toHaveLength(1);
    expect(artifacts.worktrees[0]).toEqual({
      path: '~/code/swept',
      repo: 'acme/swept',
      branch: 'feat/x',
      holding: 'half-done migration',
      name: 'main',
      default: true,
    });
  });

  it('keeps unrelated swept worktrees alongside the migrated ones', async () => {
    const dir = await writeInitiative(
      'mixed',
      BASE + ['worktrees:', '  main:', '    path: ~/code/mixed', ''].join('\n'),
      [
        'branches: []',
        'stashes: []',
        'worktrees:',
        '  - path: /tmp/wt-other',
        '    repo: ~/code/mixed',
        '',
      ].join('\n'),
    );

    await v3ToV4Worktrees.run(activeRoot);

    const artifacts = await readArtifacts(dir);
    expect(artifacts.worktrees.map((w) => w.path).sort()).toEqual([
      '/tmp/wt-other',
      '~/code/mixed',
    ]);
  });

  it('migrates several labels and keeps exactly one default', async () => {
    const dir = await writeInitiative(
      'multi',
      BASE +
        [
          'worktrees:',
          '  main:',
          '    path: ~/code/multi/main',
          '    default: true',
          '  spike:',
          '    path: ~/code/multi/spike',
          '',
        ].join('\n'),
      'branches: []\nstashes: []\n',
    );

    await v3ToV4Worktrees.run(activeRoot);

    const artifacts = await readArtifacts(dir);
    expect(artifacts.worktrees).toHaveLength(2);
    expect(artifacts.worktrees.filter((w) => w.default === true)).toHaveLength(1);
    expect(artifacts.worktrees.find((w) => w.name === 'spike')?.default).toBeUndefined();
  });

  it('is idempotent', async () => {
    const dir = await writeInitiative(
      'twice',
      BASE +
        ['worktrees:', '  main:', '    path: ~/code/twice', '    default: true', ''].join('\n'),
      'branches: []\nstashes: []\n',
    );

    await v3ToV4Worktrees.run(activeRoot);
    const first = await readFile(path.join(dir, 'artifacts.yml'), 'utf8');
    await v3ToV4Worktrees.run(activeRoot);

    expect(await readFile(path.join(dir, 'artifacts.yml'), 'utf8')).toBe(first);
    expect((await readArtifacts(dir)).worktrees).toHaveLength(1);
  });

  it('leaves a brief with no worktrees untouched', async () => {
    const dir = await writeInitiative('bare', BASE, 'branches: []\nstashes: []\n');
    const before = await readFile(path.join(dir, 'brief.md'), 'utf8');

    await v3ToV4Worktrees.run(activeRoot);

    expect(await readFile(path.join(dir, 'brief.md'), 'utf8')).toBe(before);
  });

  it('creates artifacts.yml when the initiative has none', async () => {
    const dir = await writeInitiative(
      'noartifacts',
      BASE + ['worktrees:', '  main:', '    path: ~/code/na', ''].join('\n'),
    );

    await v3ToV4Worktrees.run(activeRoot);

    expect((await readArtifacts(dir)).worktrees).toEqual([
      { path: '~/code/na', repo: '~/code/na', name: 'main' },
    ]);
  });

  it('logs what moved', async () => {
    await writeInitiative(
      'logged',
      BASE + ['worktrees:', '  main:', '    path: ~/code/logged', ''].join('\n'),
      'branches: []\nstashes: []\n',
    );

    await v3ToV4Worktrees.run(activeRoot);

    const log = await readFile(path.join(activeRoot, '.migrations.log'), 'utf8');
    expect(log).toMatch(/v3->v4\tlogged\t1 worktree\(s\)/);
  });

  it('skips directories that are not initiatives', async () => {
    await mkdir(path.join(activeRoot, '.trash'), { recursive: true });
    await writeInitiative('real', BASE, 'branches: []\nstashes: []\n');
    await expect(v3ToV4Worktrees.run(activeRoot)).resolves.toBeUndefined();
  });
});
