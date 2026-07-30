import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assembleBootstrap,
  type LiveBranchStatus,
} from '../../src/bootstrap/prompt.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const NOW = new Date('2026-07-28T12:00:00Z');
const offlineOpts = { includeLiveStatus: false, now: NOW } as const;

async function writeArtifacts(root: string, yaml: string): Promise<void> {
  await fs.writeFile(path.join(root, SLUG, 'artifacts.yml'), yaml, 'utf8');
}

async function setBriefState(root: string, frontmatter: string): Promise<void> {
  const briefPath = path.join(root, SLUG, 'brief.md');
  const raw = await fs.readFile(briefPath, 'utf8');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  await fs.writeFile(briefPath, `---\n${frontmatter}\n---\n${body}`, 'utf8');
}

describe('bootstrap worktree rendering', () => {
  it('renders a registered worktree with its branch, holding note, and default flag', async () => {
    await withTempActiveRoot(async (root) => {
      await writeArtifacts(
        root,
        [
          'branches: []',
          'stashes: []',
          'worktrees:',
          '  - path: ~/code/sample-wt',
          '    repo: ~/code/sample',
          '    branch: feat/sample',
          '    holding: half-migrated schema',
          '    name: sample-feature',
          '    default: true',
          '',
        ].join('\n'),
      );

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      expect(prompt).toContain('Worktrees (registered):');
      expect(prompt).toContain(
        '- sample-feature (default): ~/code/sample-wt [feat/sample] — half-migrated schema',
      );
    });
  });

  it('excludes observed-only worktrees from the list, reporting them as a count', async () => {
    await withTempActiveRoot(async (root) => {
      await writeArtifacts(
        root,
        [
          'branches: []',
          'stashes: []',
          'worktrees:',
          '  - path: ~/code/sample-wt',
          '    repo: ~/code/sample',
          '    name: sample-feature',
          '  - path: ~/code/unrelated-one',
          '    repo: ~/code/unrelated',
          '  - path: ~/code/unrelated-two',
          '    repo: ~/code/unrelated',
          '',
        ].join('\n'),
      );

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      expect(prompt).toContain('- sample-feature: ~/code/sample-wt');
      expect(prompt).not.toContain('~/code/unrelated-one');
      expect(prompt).not.toContain('~/code/unrelated-two');
      expect(prompt).toContain(
        `(+2 observed worktrees swept from git, not registered — \`active-work artifact list ${SLUG}\`)`,
      );
    });
  });

  it('omits the worktree block entirely when none are recorded', async () => {
    await withTempActiveRoot(async (root) => {
      await writeArtifacts(root, 'branches: []\nstashes: []\nworktrees: []\n');

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      expect(prompt).not.toContain('Worktrees');
    });
  });
});

describe('bootstrap live branch line', () => {
  it('renders last commit date plus the PR title and url', async () => {
    await withTempActiveRoot(async (root) => {
      await writeArtifacts(
        root,
        [
          'branches:',
          '  - repo: ~/code/sample',
          '    name: feat/sample',
          'stashes: []',
          'worktrees: []',
          '',
        ].join('\n'),
      );

      const status: LiveBranchStatus = {
        repo: '~/code/sample',
        name: 'feat/sample',
        present: true,
        last_commit_iso: '2026-07-21T09:14:00Z',
        ahead: 3,
        behind: 1,
        pr: {
          number: 42,
          state: 'OPEN',
          title: 'Render registered worktrees in bootstrap',
          url: 'https://github.com/HJewkes/active-work/pull/42',
          checks: 'pass (4/4)',
        },
      };

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        now: NOW,
        includeLiveStatus: true,
        liveStatusFetcher: async () => [status],
      });

      expect(prompt).toContain('Branches (live):');
      expect(prompt).toContain('last commit 2026-07-21');
      expect(prompt).toContain('PR #42 OPEN pass (4/4)');
      expect(prompt).toContain(
        '  PR: Render registered worktrees in bootstrap — https://github.com/HJewkes/active-work/pull/42',
      );
    });
  });

  it('omits the commit and PR detail when they are unavailable', async () => {
    await withTempActiveRoot(async (root) => {
      await writeArtifacts(
        root,
        [
          'branches:',
          '  - repo: ~/code/sample',
          '    name: feat/sample',
          'stashes: []',
          'worktrees: []',
          '',
        ].join('\n'),
      );

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        now: NOW,
        includeLiveStatus: true,
        liveStatusFetcher: async () => [
          {
            repo: '~/code/sample',
            name: 'feat/sample',
            present: false,
            last_commit_iso: null,
            ahead: null,
            behind: null,
            pr: null,
          },
        ],
      });

      expect(prompt).toContain('- feat/sample (~/code/sample) [missing locally]');
      expect(prompt).not.toContain('last commit');
      expect(prompt).not.toContain('PR:');
    });
  });
});

describe('bootstrap initiative state', () => {
  it('surfaces paused_since and the restart trigger when the initiative is paused', async () => {
    await withTempActiveRoot(async (root) => {
      await setBriefState(
        root,
        [
          'schema_version: 1',
          'title: Sample Initiative',
          'updated: 2026-05-10',
          'state: paused',
          "paused_since: '2026-06-28'",
          'restart_trigger: when the upstream API ships',
          'task_prefix: SI',
        ].join('\n'),
      );

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      expect(prompt).toContain('# Initiative state: paused');
      expect(prompt).toContain('Paused since 2026-06-28 (30 days ago');
      expect(prompt).toContain('Restart trigger: when the upstream API ships');
      expect(prompt).toContain('confirm with the user before treating its tasks as current work');
    });
  });

  it('surfaces a backburner state even without paused_since', async () => {
    await withTempActiveRoot(async (root) => {
      await setBriefState(
        root,
        [
          'schema_version: 1',
          'title: Sample Initiative',
          'updated: 2026-05-10',
          'state: backburner',
          'task_prefix: SI',
        ].join('\n'),
      );

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      expect(prompt).toContain('# Initiative state: backburner');
      expect(prompt).not.toContain('Paused since');
    });
  });

  it('says nothing about state for a focused initiative', async () => {
    await withTempActiveRoot(async (root) => {
      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      expect(prompt).not.toContain('# Initiative state');
    });
  });
});
