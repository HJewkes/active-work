import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleBootstrap,
  formatElapsedShort,
  formatTimeSince,
  type LiveStatusFetcher,
  type SiblingProbe,
  type SiblingSession,
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
  no_loops?: true;
}

function nextStepLines(steps: NextStepFixture[]): string[] {
  if (steps.length === 0) return [];
  const lines = ['next_steps:'];
  for (const step of steps) {
    lines.push(`  - id: ${step.id}`);
    // Quoted: an unquoted ` #3` would start a YAML comment and truncate the text.
    lines.push(`    text: ${JSON.stringify(step.text)}`);
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
 * Write a session file into the fixture initiative, named like `wrap` does.
 * Returns the filename stem — the identity half of a loop `ref`.
 */
async function writeSession(activeRoot: string, session: SessionFixture): Promise<string> {
  const hhmm = session.started.slice(11, 13) + session.started.slice(14, 16);
  const stem = `${session.started.slice(0, 10)}-${hhmm}-${session.session_id}`;
  const front = [
    '---',
    `session_id: ${session.session_id}`,
    `started: ${session.started}`,
    `ended: ${session.ended}`,
    `track: ${session.track}`,
    ...(session.no_loops ? ['no_loops: true'] : []),
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

/** Write an open task file into the fixture initiative: id plus given fields. */
async function writeTask(activeRoot: string, id: string, fields: string[]): Promise<void> {
  await fs.writeFile(
    path.join(activeRoot, SAMPLE_SLUG, 'tasks', `${id}.yml`),
    [
      `id: ${id}`,
      ...fields,
      'created: 2026-05-09',
      'updated: 2026-05-10',
      'done_at: null',
      '',
    ].join('\n'),
  );
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
      expect(metadata.last_session?.filename).toBe('2026-05-10-1430-fixture001.md');
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
      expect(metadata.last_session?.filename).toBe('2026-05-11-0900-side-new.md');
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

  it('summarizes an open task with its done_when, not its notes (AW-82)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      // SI-1 carries both fields; done_when is the completion criterion, so it wins.
      expect(prompt).toContain('done when: It compiles');
      expect(prompt).not.toContain('notes: Some blocking note here.');
    });
  });

  it('falls back to a bounded, marked notes excerpt without done_when (AW-82)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeTask(activeRoot, 'SI-5', [
        'title: No completion criterion',
        'priority: 2',
        'status: open',
        'notes: |',
        '  First note line.',
        '  Second note line.',
        '  Third note line.',
        '  Fourth note line.',
      ]);
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).toContain(
        'notes: First note line. Second note line.…' +
          `(+2 lines — see \`active-work task list ${SAMPLE_SLUG} --json\`)`,
      );
      expect(prompt).not.toContain('Third note line.');
    });
  });

  it('marks a notes excerpt clipped mid-line (AW-82)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeTask(activeRoot, 'SI-6', [
        'title: Very chatty task',
        'priority: 2',
        'status: open',
        `notes: Rambling context ${'x'.repeat(400)}`,
      ]);
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      const line = prompt.split('\n').find((l) => l.includes('notes: Rambling context'));
      expect(line).toBeDefined();
      expect(line!.length).toBeLessThan(300);
      expect(line).toContain(`…(+1 line — see \`active-work task list ${SAMPLE_SLUG} --json\`)`);
    });
  });

  it('renders a task with neither done_when nor notes without blanking (AW-82)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeTask(activeRoot, 'SI-7', ['title: Bare task', 'priority: 2', 'status: open']);
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      const line = prompt.split('\n').find((l) => l.includes('[SI-7]'));
      expect(line).toBe('2. [SI-7] (priority 2) Bare task');
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
      expect(prompt).toContain(
        `1 task completed — \`active-work task list ${SAMPLE_SLUG} --status done --json\``,
      );
      expect(metadata.recently_done_count).toBe(1);
    });
  });

  it('summarizes recently-done as a count and pointer, never a task dump', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const tasksDir = path.join(activeRoot, SAMPLE_SLUG, 'tasks');
      await fs.writeFile(
        path.join(tasksDir, 'SI-4.yml'),
        [
          'id: SI-4',
          'title: Another finished task',
          'priority: 4',
          'status: done',
          'created: 2026-05-08',
          'updated: 2026-05-10',
          'done_at: 2026-05-10',
          '',
        ].join('\n'),
      );

      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        recentlyDoneDays: 14,
        ...offlineOpts,
      });

      expect(prompt).toContain(
        `2 tasks completed — \`active-work task list ${SAMPLE_SLUG} --status done --json\``,
      );
      expect(prompt).not.toContain('Another finished task');
      expect(prompt).not.toContain('Second sample task, already done');
      expect(metadata.recently_done_count).toBe(2);
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
      expect(metadata.bootstrap_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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
      expect(prompt).toContain('active-work wrap --track adhoc');
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

  // AW-59: an abandonment is a decision. A session that cannot see it will
  // propose the abandoned thing again.
  it('renders an abandoned loop with the reason it was dropped', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const opener = await writeSession(activeRoot, {
        session_id: 'opener1',
        started: '2026-05-08T09:00:00Z',
        ended: '2026-05-08T10:00:00Z',
        track: 'canonical',
        next_steps: [{ id: 'n1', text: 'rewrite the picker in ink', kind: 'prose' }],
        body: 'opened\n',
      });
      await writeSession(activeRoot, {
        session_id: 'closer1',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T10:00:00Z',
        track: 'canonical',
        resolves: [
          {
            ref: `${opener}#n1`,
            outcome: 'abandoned',
            note: 'ink pulls in 40 deps for one screen',
          },
        ],
        body: 'closed\n',
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('# Abandoned in the last 14 days (1)');
      expect(prompt).toContain('rewrite the picker in ink');
      expect(prompt).toContain('why: ink pulls in 40 deps for one screen');
      // It closed, so it must not also be reported as hanging.
      expect(prompt).not.toContain(`ref ${opener}#n1`);
    });
  });

  it('omits loops closed as done from the abandoned section', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const opener = await writeSession(activeRoot, {
        session_id: 'opener2',
        started: '2026-05-08T09:00:00Z',
        ended: '2026-05-08T10:00:00Z',
        track: 'canonical',
        next_steps: [{ id: 'n1', text: 'land the fix', kind: 'prose' }],
        body: 'opened\n',
      });
      await writeSession(activeRoot, {
        session_id: 'closer2',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T10:00:00Z',
        track: 'canonical',
        resolves: [{ ref: `${opener}#n1`, outcome: 'done' }],
        body: 'closed\n',
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).not.toContain('# Abandoned in the last');
    });
  });

  it('omits the abandoned section entirely when there is nothing to show', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).not.toContain('# Abandoned in the last');
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
      expect(metadata.last_session?.filename).toBe('2026-05-10-1430-fixture001.md');
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
      expect(metadata.last_session?.filename).toBe('2026-05-11-1730-short-run.md');
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
        next_steps: [{ id: 's1', text: 'SQLite index blocked on eval harness', kind: 'prose' }],
      });
      await writeSession(activeRoot, {
        session_id: 'loop-new',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- New session\n',
        next_steps: [{ id: 's1', text: 'awaiting review', kind: 'pr', ref: '57' }],
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

  it('does not restate a ref the loop text already opens with (AW-71)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'restated',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- Restated refs\n',
        next_steps: [
          { id: 's1', text: 'SI-1 Drain the miner backlog', kind: 'task', ref: 'SI-1' },
          {
            id: 's2',
            text: 'PR #3 (agent-chat) is open',
            kind: 'pr',
            ref: 'https://github.com/HJewkes/agent-chat/pull/3',
          },
        ],
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('[1d] SI-1 Drain the miner backlog');
      expect(prompt).toContain('[1d] PR #3 (agent-chat) is open');
      expect(prompt).not.toContain('SI-1 SI-1');
      expect(prompt).not.toContain('github.com/HJewkes/agent-chat/pull/3 PR #3');
    });
  });

  it('keeps both refs visible when the ledger ref and the text disagree (AW-71)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'mismatch',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- Mismatched refs\n',
        next_steps: [
          { id: 's1', text: 'SI-2 is done, so unblock this', kind: 'task', ref: 'SI-1' },
        ],
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('[1d] SI-1 SI-2 is done, so unblock this');
    });
  });

  it('normalizes a URL pr ref down to its number in the label (AW-71)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'url-ref',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- URL ref\n',
        next_steps: [
          {
            id: 's1',
            text: 'awaiting review',
            kind: 'pr',
            ref: 'https://github.com/HJewkes/agent-chat/pull/3',
          },
        ],
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('[1d] PR #3 awaiting review');
    });
  });

  it('says nothing was asserted clear when no session filed a no_loops marker', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });
      expect(prompt).toContain(
        '# Open loops\nNothing hanging — no unresolved loops, but no session has asserted the ledger is clear.',
      );
      expect(metadata.open_loop_count).toBe(0);
    });
  });

  it('credits the newest session when it asserted the ledger is clear', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'all-clear',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- Confirmed nothing hanging\n',
        no_loops: true,
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain(
        '# Open loops\nNothing hanging — the 2026-05-11 session asserted the ledger is clear.',
      );
    });
  });

  // AW-83: the closing directive is loop-first only when there is a loop to
  // work. With an empty ledger it stays on the top-task framing, so the render
  // never points a session at loops it just said were absent.
  it('closes with loop-first framing when loops are hanging (AW-83)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'loop-one',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- Left something hanging\n',
        next_steps: [
          { id: 's1', text: 'SQLite index blocked on eval harness', kind: 'prose' },
          { id: 's2', text: 'awaiting review', kind: 'pr', ref: '57' },
        ],
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('Start with the open loops: 2 are still hanging');
      expect(prompt).toContain('unfinished threads take precedence over the backlog');
      // The mechanism a session needs to actually close one.
      expect(prompt).toContain('`ref` printed under "Open loops"');
      expect(prompt).toContain('`active-work wrap --resolves`');
      // Priority order is stated, not the bare old directive.
      expect(prompt).toContain('Once the loops are handled, or if the user redirects');
      expect(prompt).not.toContain('Work the top task unless redirected.');
    });
  });

  it('agrees in number with a single hanging loop (AW-83)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'loop-solo',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- One thread left open\n',
        next_steps: [{ id: 's1', text: 'SQLite index blocked on eval harness', kind: 'prose' }],
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('Start with the open loop: 1 is still hanging');
    });
  });

  it('falls back to top-task framing when no loops are hanging (AW-83)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'all-clear',
        started: '2026-05-11T09:00:00Z',
        ended: '2026-05-11T16:00:00Z',
        track: 'canonical',
        body: '- Confirmed nothing hanging\n',
        no_loops: true,
      });

      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('Work the top task unless redirected.');
      expect(prompt).not.toContain('Start with the open loop');
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

/**
 * Bootstrap and the loop derivation must agree about which session files
 * parsed. When they disagree, bootstrap renders a healthy recent session while
 * every loop it opened silently vanishes from the ledger — the failure mode is
 * invisible precisely because the prompt still looks correct.
 */
describe('assembleBootstrap session parsing', () => {
  const LOOP_FM = [
    'session_id: edge',
    'started: 2026-05-09T09:00:00Z',
    'ended: 2026-05-09T16:00:00Z',
    'track: canonical',
    'next_steps:',
    '  - id: s1',
    '    text: edge case loop',
    '    kind: prose',
  ].join('\n');

  async function bootstrapWithRawSession(activeRoot: string, contents: string): Promise<string> {
    await fs.writeFile(
      path.join(activeRoot, SAMPLE_SLUG, 'sessions', '2026-05-09-0900-edge.md'),
      contents,
      'utf8',
    );
    const { prompt } = await assembleBootstrap({
      activeRoot,
      slug: SAMPLE_SLUG,
      now: FIXTURE_NOW,
      ...offlineOpts,
    });
    return prompt;
  }

  const variants: Record<string, string> = {
    plain: `---\n${LOOP_FM}\n---\n\n- Edge body\n`,
    'utf-8 BOM': `\uFEFF---\n${LOOP_FM}\n---\n\n- Edge body\n`,
    'delimiter with trailing space': `--- \n${LOOP_FM}\n---\n\n- Edge body\n`,
  };

  for (const [label, contents] of Object.entries(variants)) {
    it(`renders and derives consistently for a session with a ${label}`, async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const prompt = await bootstrapWithRawSession(activeRoot, contents);
        // The two consumers agree: the loop reaches the ledger exactly when
        // bootstrap did not have to report the file as unreadable.
        const unreadable = prompt.includes('session file(s) unreadable');
        expect(prompt.includes('edge case loop')).toBe(!unreadable);
      });
    });
  }

  it('annotates the open loops heading when a session file cannot be read', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const prompt = await bootstrapWithRawSession(
        activeRoot,
        '---\nsession_id: broken\nended: not-a-timestamp\n---\n\nbroken\n',
      );
      expect(prompt).toContain(
        '# Open loops (1 session file(s) unreadable — run `active-work doctor`)',
      );
    });
  });

  it('renders the malformed file without dropping the loops of readable ones', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(activeRoot, {
        session_id: 'healthy',
        started: '2026-05-09T09:00:00Z',
        ended: '2026-05-09T16:00:00Z',
        track: 'canonical',
        body: '- Healthy\n',
        next_steps: [{ id: 's1', text: 'surviving loop', kind: 'prose' }],
      });
      await fs.writeFile(
        path.join(activeRoot, SAMPLE_SLUG, 'sessions', '2026-05-09-1000-bad.md'),
        'not a session at all\n',
        'utf8',
      );

      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ...offlineOpts,
      });

      expect(prompt).toContain('surviving loop');
      expect(prompt).toContain('1 session file(s) unreadable');
      expect(metadata.open_loop_count).toBe(1);
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
    expect(formatTimeSince(from, now)).toBe('18 days ago — likely needs context refresher');
  });
});

describe('sibling-session detection (CC-9)', () => {
  const LAUNCHER_SIBLING: SiblingSession = {
    lease_id: 'aaaa',
    cwd: '/Users/dev/code/sample',
    mode: 'launcher',
    pid: 4321,
    started: '2026-05-12T15:48:00Z',
  };
  const ONESHOT_SIBLING: SiblingSession = {
    lease_id: 'bbbb',
    cwd: '/Users/dev/code/other-checkout',
    mode: 'oneshot',
    started: '2026-05-12T15:48:00Z',
  };

  function probeReturning(siblings: SiblingSession[]): SiblingProbe {
    return async () => siblings;
  }

  /** The bootstrap timestamp is wall-clock, so it can never match across runs. */
  function normalize(prompt: string): string {
    return prompt.replace(/^- Bootstrap: .*$/m, '- Bootstrap: <ts>');
  }

  async function addChannels(activeRoot: string, channels: string[]): Promise<void> {
    const briefPath = path.join(activeRoot, SAMPLE_SLUG, 'brief.md');
    const raw = await fs.readFile(briefPath, 'utf8');
    const block = ['channels:', ...channels.map((c) => `  - ${c}`)].join('\n');
    await fs.writeFile(briefPath, raw.replace(/^task_prefix: SI$/m, `task_prefix: SI\n${block}`));
  }

  it('renders the warning between the opening line and "Why we\'re doing this"', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([LAUNCHER_SIBLING]),
        ...offlineOpts,
      });

      const opening = prompt.indexOf('Starting a session on');
      const warning = prompt.indexOf('# Another session may already be live');
      const why = prompt.indexOf("# Why we're doing this");
      expect(warning).toBeGreaterThan(opening);
      expect(warning).toBeLessThan(why);
      expect(metadata.sibling_sessions).toBe(1);
    });
  });

  it('names the sibling cwd, its elapsed time, and the --track adhoc directive', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([LAUNCHER_SIBLING]),
        ...offlineOpts,
      });
      expect(prompt).toContain('/Users/dev/code/sample');
      expect(prompt).toContain('12m ago');
      expect(prompt).toContain('active-work wrap --track adhoc');
      // The top task is named so the ownership question is answerable.
      expect(prompt).toContain('First sample task');
    });
  });

  // The two modes carry different amounts of truth: one is a signalled process,
  // the other a TTL guess. Rendering them identically would flatten that.
  it('states a launcher sibling as a live process, pid and all', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([LAUNCHER_SIBLING]),
        ...offlineOpts,
      });
      expect(prompt).toContain('process still running (pid 4321)');
      expect(prompt).not.toContain('may have already exited');
    });
  });

  it('hedges a oneshot sibling, which has no process to confirm', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([ONESHOT_SIBLING]),
        ...offlineOpts,
      });
      expect(prompt).toContain('no live process to confirm');
      expect(prompt).toContain('may have already exited');
      expect(prompt).not.toContain('pid');
    });
  });

  it('adds the agent-chat sentence only when the brief carries that channel', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const before = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([LAUNCHER_SIBLING]),
        ...offlineOpts,
      });
      expect(before.prompt).not.toContain('agent-chat');

      await addChannels(activeRoot, ['plugin:agent-chat@local']);
      const after = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([LAUNCHER_SIBLING]),
        ...offlineOpts,
      });
      expect(after.prompt).toContain('register under a name that distinguishes you');
    });
  });

  it('ignores unrelated channels when deciding on the agent-chat sentence', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await addChannels(activeRoot, ['server:voltras']);
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([LAUNCHER_SIBLING]),
        ...offlineOpts,
      });
      expect(prompt).toContain('# Another session may already be live');
      expect(prompt).not.toContain('agent-chat');
    });
  });

  // Regression guard: with nothing to warn about, this feature must be
  // invisible — the whole prompt, not merely the absence of the heading.
  it('produces byte-identical output to a probe-free bootstrap when empty', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const withoutFeature = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        detectSiblings: false,
        ...offlineOpts,
      });
      const withEmptyProbe = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([]),
        ...offlineOpts,
      });
      expect(normalize(withEmptyProbe.prompt)).toBe(normalize(withoutFeature.prompt));
      expect(withEmptyProbe.metadata.sibling_sessions).toBeUndefined();
      expect(withoutFeature.metadata.sibling_sessions).toBeUndefined();
    });
  });

  it('does not call the probe at all when detectSiblings is false', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      let calls = 0;
      const probe: SiblingProbe = async () => {
        calls++;
        return [LAUNCHER_SIBLING];
      };
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        detectSiblings: false,
        siblingProbe: probe,
        ...offlineOpts,
      });
      expect(calls).toBe(0);
      expect(prompt).not.toContain('# Another session may already be live');
    });
  });

  it('passes the caller’s own lease id to the probe so it excludes itself', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      let seen: string | undefined;
      const probe: SiblingProbe = async (input) => {
        seen = input.excludeLeaseId;
        return [];
      };
      await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        ownLeaseId: 'deadbeef',
        siblingProbe: probe,
        ...offlineOpts,
      });
      expect(seen).toBe('deadbeef');
    });
  });

  // Fail open: this section is advisory, and bootstrap runs on every launch.
  it('still produces a complete prompt when the probe throws', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const thrower: SiblingProbe = async () => {
        throw new Error('lease dir on fire');
      };
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: thrower,
        ...offlineOpts,
      });
      expect(prompt).toContain("# Why we're doing this");
      expect(prompt).toContain('# Tasks (top 5 open by priority)');
      expect(prompt).toContain('Work the top task unless redirected.');
      expect(prompt).not.toContain('# Another session may already be live');
      expect(metadata.sibling_sessions).toBeUndefined();
    });
  });

  it('renders one line per sibling', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await assembleBootstrap({
        activeRoot,
        slug: SAMPLE_SLUG,
        now: FIXTURE_NOW,
        siblingProbe: probeReturning([LAUNCHER_SIBLING, ONESHOT_SIBLING]),
        ...offlineOpts,
      });
      expect(metadata.sibling_sessions).toBe(2);
      expect(prompt).toContain('/Users/dev/code/sample');
      expect(prompt).toContain('/Users/dev/code/other-checkout');
    });
  });
});

describe('formatElapsedShort', () => {
  const now = new Date('2026-05-12T12:00:00Z');

  it('reports sub-minute ages as "just started"', () => {
    expect(formatElapsedShort(new Date('2026-05-12T11:59:30Z'), now)).toBe('just started');
  });

  it('reports minutes under an hour', () => {
    expect(formatElapsedShort(new Date('2026-05-12T11:23:00Z'), now)).toBe('37m ago');
  });

  it('reports whole hours without a minutes remainder', () => {
    expect(formatElapsedShort(new Date('2026-05-12T10:00:00Z'), now)).toBe('2h ago');
  });

  it('reports hours and minutes together', () => {
    expect(formatElapsedShort(new Date('2026-05-12T09:35:00Z'), now)).toBe('2h 25m ago');
  });
});
