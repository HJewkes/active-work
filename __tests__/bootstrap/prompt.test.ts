import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleBootstrap,
  formatTimeSince,
} from '../../src/bootstrap/prompt.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SAMPLE_SLUG = 'sample-initiative';
const FIXTURE_NOW = new Date('2026-05-12T16:00:00Z');

describe('assembleBootstrap', () => {
  it('returns a prompt that includes the slug and brief title', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
      });
      expect(prompt).toContain('`sample-initiative`');
      expect(prompt).toContain('Sample Initiative');
      expect(metadata.slug).toBe(SAMPLE_SLUG);
      expect(metadata.brief_title).toBe('Sample Initiative');
    });
  });

  it('picks the most recent canonical session', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
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
      // Remove the lone canonical session
      const sessionsDir = path.join(activeRoot, SAMPLE_SLUG, 'sessions');
      const entries = await fs.readdir(sessionsDir);
      for (const file of entries) {
        await fs.unlink(path.join(sessionsDir, file));
      }
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
      });
      expect(prompt).toContain('No previous sessions recorded.');
      expect(metadata.last_session).toBeUndefined();
      expect(metadata.time_since_last_session_human).toBeUndefined();
    });
  });

  it('lists open tasks sorted by priority', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // Add a higher-priority task (priority 0 is rejected; smaller = higher).
      // Existing SI-1 is priority 1 / open; SI-2 is done; add SI-3 priority 1 (tie).
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
      // SI-2 is done at 2026-05-10. With a now of 2026-05-12 + window=1d, it falls out.
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        recentlyDoneDays: 1,
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
      });
      expect(prompt).toContain('# Recently done (last 14 days)');
      expect(prompt).toContain('[SI-2]');
      expect(metadata.recently_done_count).toBe(1);
    });
  });

  it('pulls open PRs from artifacts.yml into the artifacts section', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
      });
      expect(prompt).toContain('# Open artifacts');
      expect(prompt).toContain('#42 (HJewkes/sample) Sample PR');
      expect(metadata.open_pr_count).toBe(1);
    });
  });

  it('stamps bootstrap context: today + ISO timestamp + time since last', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
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
