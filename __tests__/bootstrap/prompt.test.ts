import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleBootstrap,
  formatTimeSince,
  type LiveStatusFetcher,
} from '../../src/bootstrap/prompt.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SAMPLE_SLUG = 'sample-initiative';
const FIXTURE_NOW = new Date('2026-05-12T16:00:00Z');

const offlineOpts = { includeLiveStatus: false } as const;

describe('assembleBootstrap', () => {
  it('returns a prompt that includes the slug and brief title', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).toContain('`sample-initiative`');
      expect(prompt).toContain('Sample Initiative');
      expect(metadata.slug).toBe(SAMPLE_SLUG);
      expect(metadata.brief_title).toBe('Sample Initiative');
    });
  });

  it('uses the default framing (top-task directive) when not ad-hoc', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).toContain('Starting a session on `sample-initiative`');
      expect(prompt).toContain('Work the top task unless redirected.');
      expect(prompt).not.toContain('ad-hoc session');
    });
  });

  it('reframes the opening and closing when adhoc is set (AW-20)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        adhoc: true,
        ...offlineOpts,
      });
      expect(prompt).toContain('Starting an ad-hoc session on `sample-initiative`');
      expect(prompt).toContain('wait for the user to describe the specific ad-hoc task');
      expect(prompt).toContain('treat the context above as background, not a directive');
      // The normal top-task directive is replaced, not appended.
      expect(prompt).not.toContain('Work the top task unless redirected.');
    });
  });

  it('renders a housekeeping note for archived task ids (AW-8)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        archivedTaskIds: ['AW-7', 'AW-9'],
        ...offlineOpts,
      });
      expect(prompt).toContain('# Archived (housekeeping)');
      expect(prompt).toContain('AW-7, AW-9');
    });
  });

  it('omits the archived section when nothing was archived', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        archivedTaskIds: [],
        ...offlineOpts,
      });
      expect(prompt).not.toContain('# Archived (housekeeping)');
    });
  });

  it('picks the most recent canonical session', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(metadata.last_session?.filename).toBe(
        '2026-05-10-1430-fixture001.md',
      );
      expect(prompt).toContain('fixture001');
      expect(prompt).toContain('# Last session');
    });
  });

  it('falls back when no sessions exist', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const sessionsDir = path.join(activeRoot, SAMPLE_SLUG, 'sessions');
      const entries = await fs.readdir(sessionsDir);
      for (const file of entries) {
        await fs.unlink(path.join(sessionsDir, file));
      }
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).toContain('No previous sessions recorded.');
      expect(metadata.last_session).toBeUndefined();
      expect(metadata.time_since_last_session_human).toBeUndefined();
    });
  });

  it('lists open tasks sorted by priority', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const tasksDir = path.join(activeRoot, SAMPLE_SLUG, 'tasks');
      await fs.writeFile(
        path.join(tasksDir, 'SI-3.yml'),
        [
          'id: SI-3',
          'title: Triage second task',
          'priority: 2',
          'status: open',
          'created: 2026-05-09',
          'updated: 2026-05-10',
          'done_at: null',
          '',
        ].join('\n'),
      );
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      const si1Idx = prompt.indexOf('[SI-1]');
      const si3Idx = prompt.indexOf('[SI-3]');
      expect(si1Idx).toBeGreaterThan(-1);
      expect(si3Idx).toBeGreaterThan(-1);
      expect(si1Idx).toBeLessThan(si3Idx);
      expect(metadata.open_task_count).toBe(2);
    });
  });

  it('omits the recently-done section when no done tasks fall in the window', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        recentlyDoneDays: 1,
        ...offlineOpts,
      });
      expect(prompt).not.toContain('# Recently done');
      expect(metadata.recently_done_count).toBe(0);
    });
  });

  it('includes the recently-done section when within window', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        recentlyDoneDays: 14,
        ...offlineOpts,
      });
      expect(prompt).toContain('# Recently done (last 14 days)');
      expect(prompt).toContain('[SI-2]');
      expect(metadata.recently_done_count).toBe(1);
    });
  });

  it('renders tracked branches statically when live status is disabled', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).toContain('# Open artifacts');
      expect(prompt).toContain('Branches:');
      expect(prompt).toContain('feat/sample (~/code/sample)');
      expect(prompt).toContain('scaffolding for sample initiative');
      expect(prompt).not.toContain('Branches (live):');
      expect(prompt).not.toContain('PR #');
    });
  });

  it('renders live branch status via the injected fetcher', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const fetcher: LiveStatusFetcher = async (branches) =>
        branches.map((b) => ({
          repo: b.repo,
          name: b.name,
          note: b.note,
          present: true,
          last_commit_iso: '2026-05-12T10:00:00Z',
          ahead: 3,
          behind: 1,
          pr: {
            number: 99,
            state: 'OPEN',
            title: 'Some PR',
            url: 'https://example.test/pr/99',
            checks: 'pass (5/5)',
          },
        }));
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        includeLiveStatus: true,
        liveStatusFetcher: fetcher,
      });
      expect(prompt).toContain('Branches (live):');
      expect(prompt).toContain('feat/sample');
      expect(prompt).toContain('+3/-1');
      expect(prompt).toContain('PR #99 OPEN pass (5/5)');
    });
  });

  it('degrades to static rendering when the live fetcher throws', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const fetcher: LiveStatusFetcher = async () => {
        throw new Error('gh unreachable');
      };
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        includeLiveStatus: true,
        liveStatusFetcher: fetcher,
      });
      expect(prompt).toContain('Branches:');
      expect(prompt).toContain('feat/sample (~/code/sample)');
      expect(prompt).not.toContain('Branches (live):');
    });
  });

  it('truncates the live branch list and reports overflow', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const artifactsPath = path.join(activeRoot, SAMPLE_SLUG, 'artifacts.yml');
      const lines: string[] = ['branches:'];
      for (let i = 0; i < 12; i++) {
        lines.push(`  - repo: ~/code/sample`);
        lines.push(`    name: feat/b-${i}`);
      }
      lines.push('stashes: []');
      lines.push('');
      await fs.writeFile(artifactsPath, lines.join('\n'));

      const fetcher: LiveStatusFetcher = async (branches) =>
        branches.map((b) => ({
          repo: b.repo,
          name: b.name,
          note: b.note,
          present: true,
          last_commit_iso: null,
          ahead: 0,
          behind: 0,
          pr: null,
        }));
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        includeLiveStatus: true,
        liveStatusFetcher: fetcher,
      });
      expect(prompt).toContain('Branches (live):');
      expect(prompt).toContain('feat/b-9');
      expect(prompt).toContain('(+2 more)');
      const idxMore = prompt.indexOf('(+2 more)');
      const idxLast = prompt.indexOf('feat/b-11');
      expect(idxLast === -1 || idxLast > idxMore).toBe(true);
    });
  });

  it('stamps bootstrap context: today + ISO timestamp + time since last', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).toContain('# Context');
      expect(prompt).toContain('- Today: ');
      expect(prompt).toContain('- Bootstrap: ');
      expect(metadata.bootstrap_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });
  });
});

describe('formatTimeSince', () => {
  it('returns "just now" inside the first hour', () => {
    const now = new Date('2026-05-12T12:00:00Z');
    const from = new Date('2026-05-12T11:30:00Z');
    expect(formatTimeSince(from, now)).toBe('just now');
  });

  it('returns hours-ago between 1h and 24h', () => {
    const now = new Date('2026-05-12T12:00:00Z');
    const from = new Date('2026-05-12T07:00:00Z');
    expect(formatTimeSince(from, now)).toBe('5 hours ago');
  });

  it('uses singular form for 1 hour', () => {
    const now = new Date('2026-05-12T12:00:00Z');
    const from = new Date('2026-05-12T10:30:00Z');
    expect(formatTimeSince(from, now)).toBe('1 hour ago');
  });

  it('returns days-ago between 1d and 14d', () => {
    const now = new Date('2026-05-12T12:00:00Z');
    const from = new Date('2026-05-09T12:00:00Z');
    expect(formatTimeSince(from, now)).toBe('3 days ago');
  });

  it('appends refresher hint at 14+ days', () => {
    const now = new Date('2026-05-30T12:00:00Z');
    const from = new Date('2026-05-12T12:00:00Z');
    expect(formatTimeSince(from, now)).toBe(
      '18 days ago — likely needs context refresher',
    );
  });
});
