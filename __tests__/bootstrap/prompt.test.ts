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

interface NextStepFixture {
  id: string;
  text: string;
  kind: 'task' | 'pr' | 'prose';
  ref?: string;
}

interface ResolveFixture {
  ref: string;
  outcome: 'done' | 'abandoned';
  note?: string;
}

interface SessionFixture {
  session_id: string;
  started: string;
  ended: string;
  track: 'canonical' | 'sidecar' | 'adhoc';
  body: string;
  next_steps?: NextStepFixture[];
  resolves?: ResolveFixture[];
}

function nextStepLines(steps: NextStepFixture[]): string[] {
  if (steps.length === 0) return [];
  const lines = ['next_steps:'];
  for (const step of steps) {
    lines.push(`  - id: ${step.id}`);
    lines.push(`    text: ${step.text}`);
    lines.push(`    kind: ${step.kind}`);
    // Quoted: a bare `57` would parse as a number and fail the string schema.
    if (step.ref !== undefined) lines.push(`    ref: '${step.ref}'`);
  }
  return lines;
}

function resolveLines(entries: ResolveFixture[]): string[] {
  if (entries.length === 0) return [];
  const lines = ['resolves:'];
  for (const entry of entries) {
    lines.push(`  - ref: ${entry.ref}`);
    lines.push(`    outcome: ${entry.outcome}`);
    if (entry.note !== undefined) lines.push(`    note: ${entry.note}`);
  }
  return lines;
}

/**
 * Write a session file into the fixture initiative, named like `session record`
 * does. Returns the filename stem — the identity half of a loop `ref`.
 */
async function writeSession(
  activeRoot: string,
  session: SessionFixture,
): Promise<string> {
  const hhmm = session.started.slice(11, 13) + session.started.slice(14, 16);
  const stem = `${session.started.slice(0, 10)}-${hhmm}-${session.session_id}`;
  const front = [
    '---',
    `session_id: ${session.session_id}`,
    `started: ${session.started}`,
    `ended: ${session.ended}`,
    `track: ${session.track}`,
    ...nextStepLines(session.next_steps ?? []),
    ...resolveLines(session.resolves ?? []),
    '---',
    '',
  ].join('\n');
  await fs.writeFile(
    path.join(activeRoot, SAMPLE_SLUG, 'sessions', `${stem}.md`),
    front + session.body,
  );
  return stem;
}

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

  it('falls back to the newest sidecar session when no canonical exists (AW-42)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const sessionsDir = path.join(activeRoot, SAMPLE_SLUG, 'sessions');
      const entries = await fs.readdir(sessionsDir);
      for (const file of entries) {
        await fs.unlink(path.join(sessionsDir, file));
      }
      await writeSession(activeRoot, {
        session_id: 'side-old',
        started: '2026-05-09T09:00:00Z',
        ended: '2026-05-09T10:00:00Z',
        track: 'sidecar',
        body: '- Older sidecar session\n',
      });
      await writeSession(activeRoot, {
        session_id: 'side-new',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T10:00:00Z',
        track: 'sidecar',
        body: '- Newest sidecar session\n',
      });

      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      // Newest session of any track becomes the narrative, labeled by track
      // so it isn't mistaken for mainline continuity.
      expect(metadata.last_session?.filename).toBe(
        '2026-05-11-0900-side-new.md',
      );
      expect(prompt).toContain('# Last session (sidecar) (2026-05-11, side-new)');
      expect(prompt).toContain('Newest sidecar session');

      // The chosen narrative session must not also appear as a parallel
      // pointer — it would be both the mainline block and a listed pointer.
      const parallelIdx = prompt.indexOf('# Parallel sessions');
      if (parallelIdx !== -1) {
        expect(prompt.slice(parallelIdx)).not.toContain('side-new');
      }
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

  it('tells ad-hoc sessions to record on the adhoc track (AW-36)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        adhoc: true,
        ...offlineOpts,
      });
      expect(prompt).toContain('active-work session record --track adhoc');
    });
  });

  it('omits the parallel-sessions block when there are none (AW-36)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).not.toContain('# Parallel sessions');
    });
  });

  it('lists adhoc and sidecar sessions newer than the last canonical one (AW-36)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'adhoc001',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T10:00:00Z',
        track: 'adhoc',
        body: '\n- Patched the flaky launcher test\n- Second line stays hidden\n',
      });
      await writeSession(activeRoot, {
        session_id: 'side001',
        started: '2026-05-11T12:00:00Z',
        ended: '2026-05-11T13:00:00Z',
        track: 'sidecar',
        body: '- Folded in a discovered branch\n',
      });

      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      // The narrative slot still belongs to the newest canonical session.
      expect(metadata.last_session?.filename).toBe(
        '2026-05-10-1430-fixture001.md',
      );
      expect(prompt).toContain('# Last session (2026-05-10, fixture001)');

      expect(prompt).toContain('# Parallel sessions since then');
      expect(prompt).toContain(
        '- 2026-05-11 (adhoc, adhoc001) — - Patched the flaky launcher test',
      );
      expect(prompt).toContain('- 2026-05-11 (sidecar, side001) — - Folded in a discovered branch');
      expect(prompt).not.toContain('Second line stays hidden');
    });
  });

  it('excludes parallel sessions older than the last canonical one (AW-36)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'old-adhoc',
        started: '2026-05-09T09:00:00Z',
        ended: '2026-05-09T10:00:00Z',
        track: 'adhoc',
        body: '- Ancient ad-hoc detour\n',
      });
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).not.toContain('# Parallel sessions');
      expect(prompt).not.toContain('old-adhoc');
    });
  });

  it('breaks equal `ended` ties on `started`, newest first (AW-36)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'long-run',
        started: '2026-05-11T08:00:00Z',
        ended: '2026-05-11T18:00:00Z',
        track: 'canonical',
        body: '- Long mainline session\n',
      });
      await writeSession(activeRoot, {
        session_id: 'short-run',
        started: '2026-05-11T17:30:00Z',
        ended: '2026-05-11T18:00:00Z',
        track: 'canonical',
        body: '- Short mainline session\n',
      });
      const { metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(metadata.last_session?.filename).toBe(
        '2026-05-11-1730-short-run.md',
      );
    });
  });
});

describe('assembleBootstrap open loops', () => {
  it('lists unresolved loops oldest first with their age', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'loop-old',
        started: '2026-04-27T09:00:00Z',
        ended: '2026-04-27T16:00:00Z',
        track: 'canonical',
        body: '- Old session\n',
        next_steps: [
          { id: 's1', text: 'SQLite index blocked on eval harness', kind: 'prose' },
        ],
      });
      await writeSession(activeRoot, {
        session_id: 'loop-new',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- New session\n',
        next_steps: [
          { id: 's1', text: 'awaiting review', kind: 'pr', ref: '57' },
        ],
      });

      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('# Open loops (2 hanging, oldest 15d)');
      expect(prompt).toContain('[15d] SQLite index blocked on eval harness');
      expect(prompt).toContain('[ 1d] PR #57 awaiting review');
      expect(prompt).toContain('(from 2026-04-27, ref 2026-04-27-0900-loop-old#s1)');
      expect(prompt.indexOf('[15d]')).toBeLessThan(prompt.indexOf('[ 1d]'));
      expect(metadata.open_loop_count).toBe(2);
    });
  });

  it('states plainly that nothing is hanging when no loops are open', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).toContain('# Open loops\nNothing hanging — no unresolved loops.');
      expect(metadata.open_loop_count).toBe(0);
    });
  });

  it('drops task loops whose task is already done', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'loop-tasks',
        started: '2026-05-08T09:00:00Z',
        ended: '2026-05-08T16:00:00Z',
        track: 'canonical',
        body: '- Task loops\n',
        next_steps: [
          { id: 'done', text: 'finish second sample task', kind: 'task', ref: 'SI-2' },
          { id: 'open', text: 'finish first sample task', kind: 'task', ref: 'SI-1' },
        ],
      });

      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('SI-1 finish first sample task');
      expect(prompt).not.toContain('finish second sample task');
      expect(metadata.open_loop_count).toBe(1);
    });
  });

  it('drops loops closed by a later session', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const stem = await writeSession(activeRoot, {
        session_id: 'loop-opener',
        started: '2026-05-05T09:00:00Z',
        ended: '2026-05-05T16:00:00Z',
        track: 'canonical',
        body: '- Opened a loop\n',
        next_steps: [{ id: 's1', text: 'wire up the daemon', kind: 'prose' }],
      });
      await writeSession(activeRoot, {
        session_id: 'loop-closer',
        started: '2026-05-06T09:00:00Z',
        ended: '2026-05-06T16:00:00Z',
        track: 'canonical',
        body: '- Closed it\n',
        resolves: [{ ref: `${stem}#s1`, outcome: 'done' }],
      });

      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).not.toContain('wire up the daemon');
      expect(metadata.open_loop_count).toBe(0);
    });
  });

  it('renders open loops above the last session and the demoted task list', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'loop-order',
        started: '2026-05-09T09:00:00Z',
        ended: '2026-05-09T16:00:00Z',
        track: 'canonical',
        body: '- Ordering fixture\n',
        next_steps: [{ id: 's1', text: 'ordering loop', kind: 'prose' }],
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      const loopsIdx = prompt.indexOf('# Open loops');
      const sessionIdx = prompt.indexOf('# Last session');
      const tasksIdx = prompt.indexOf('# Tasks (top');
      expect(loopsIdx).toBeGreaterThan(-1);
      expect(loopsIdx).toBeLessThan(sessionIdx);
      expect(sessionIdx).toBeLessThan(tasksIdx);
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
