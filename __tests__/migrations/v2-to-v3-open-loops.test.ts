import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/errors.js';
import { V3_OPEN_LOOPS_PROPOSAL } from '../../src/migrations/data/v3-open-loops-proposal.js';
import { v2ToV3OpenLoops, planV2ToV3 } from '../../src/migrations/v2-to-v3-open-loops.js';
import { PROPOSAL_PATH_ENV, ProposalSchema } from '../../src/migrations/v3-proposal.js';
import {
  deriveOpenLoops,
  findDanglingResolves,
  findSessionIssues,
} from '../../src/sessions/open-loops.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const ENDED = '2026-05-12T09:00:00Z';
const STEM = '2026-05-12-0900-handoff-migration';

const ABANDONED_NOTE =
  'The claim window closed long before the migration; recorded as abandoned so no future session chases it.';
const ABANDONED_STEP_EXTRA = { abandoned: { note: ABANDONED_NOTE } };
const ABANDONED_STEP = {
  id: 'n1',
  text: 'ABANDONED, do not chase',
  kind: 'prose',
  ...ABANDONED_STEP_EXTRA,
};

interface ScaffoldOptions {
  taskIds?: string[];
  archivedTaskIds?: string[];
  taskSeq?: number;
  handoff?: string | null;
  state?: string;
}

async function scaffold(root: string, slug: string, opts: ScaffoldOptions = {}): Promise<void> {
  const dir = path.join(root, slug);
  await fs.mkdir(path.join(dir, 'tasks', 'archive'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sources'), { recursive: true });
  const frontmatter = [
    '---',
    'schema_version: 1',
    `title: ${slug}`,
    "updated: '2026-05-12'",
    `state: ${opts.state ?? 'backburner'}`,
    'task_prefix: XX',
    ...(opts.taskSeq === undefined ? [] : [`task_seq: ${opts.taskSeq}`]),
    '---',
    '',
    `# ${slug}`,
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'brief.md'), frontmatter, 'utf8');
  for (const id of opts.taskIds ?? []) {
    await fs.writeFile(path.join(dir, 'tasks', `${id}.yml`), `id: ${id}\n`, 'utf8');
  }
  for (const id of opts.archivedTaskIds ?? []) {
    await fs.writeFile(path.join(dir, 'tasks', 'archive', `${id}.yml`), `id: ${id}\n`, 'utf8');
  }
  if (opts.handoff !== null) {
    await fs.writeFile(
      path.join(dir, 'handoff.md'),
      opts.handoff ?? '# Current state\n\nSomething was in flight.\n',
      'utf8',
    );
  }
}

async function writeProposal(root: string, initiatives: unknown[]): Promise<void> {
  const file = path.join(root, 'proposal.json');
  await fs.writeFile(file, JSON.stringify({ initiatives }), 'utf8');
  process.env[PROPOSAL_PATH_ENV] = file;
}

function entry(slug: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    slug,
    ended: ENDED,
    session_id: 'handoff-migration',
    body: 'Carried over from handoff.md.',
    next_steps: [{ id: 'n1', text: 'Finish the thing', kind: 'prose' }],
    ...overrides,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  delete process.env[PROPOSAL_PATH_ENV];
});

describe('v2 -> v3 open-loops migration', () => {
  it('writes one back-dated sidecar session whose loop ages from the real last touch', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', { taskIds: ['XX-1', 'XX-4'] });
      await writeProposal(root, [entry('alpha')]);

      await v2ToV3OpenLoops.run(root);

      const sessionPath = path.join(root, 'alpha', 'sessions', `${STEM}.md`);
      const raw = await fs.readFile(sessionPath, 'utf8');
      expect(raw).toContain('track: sidecar');
      expect(raw).toContain(`ended: '${ENDED}'`);
      expect(raw).not.toContain('no_loops');

      const loops = await deriveOpenLoops(path.join(root, 'alpha'), {
        now: new Date('2026-06-11T09:00:00Z'),
      });
      expect(loops).toHaveLength(1);
      expect(loops[0].ref).toBe(`${STEM}#n1`);
      expect(loops[0].openedAt).toBe(ENDED);
      expect(loops[0].ageDays).toBe(30);
    });
  });

  it('does not stamp brief.updated', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', { taskIds: ['XX-7'] });
      await writeProposal(root, [entry('alpha')]);

      await v2ToV3OpenLoops.run(root);

      const brief = await fs.readFile(path.join(root, 'alpha', 'brief.md'), 'utf8');
      expect(brief).toContain("updated: '2026-05-12'");
    });
  });

  it('is a no-op on a re-run — no duplicate session, no second archive', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', { taskIds: ['XX-3'] });
      await writeProposal(root, [entry('alpha')]);

      await v2ToV3OpenLoops.run(root);
      const sessionsDir = path.join(root, 'alpha', 'sessions');
      const afterFirst = await fs.readdir(sessionsDir);
      const briefAfterFirst = await fs.readFile(path.join(root, 'alpha', 'brief.md'), 'utf8');

      await v2ToV3OpenLoops.run(root);

      expect(await fs.readdir(sessionsDir)).toEqual(afterFirst);
      expect(afterFirst).toEqual([`${STEM}.md`]);
      expect(await fs.readFile(path.join(root, 'alpha', 'brief.md'), 'utf8')).toBe(briefAfterFirst);
      const loops = await deriveOpenLoops(path.join(root, 'alpha'), {
        now: new Date('2026-06-11T09:00:00Z'),
      });
      expect(loops).toHaveLength(1);
    });
  });

  it('validates the whole batch first: a bad entry leaves nothing written', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', { taskIds: ['XX-1'] });
      await scaffold(root, 'zulu', { taskIds: ['XX-2'] });
      // `zulu` sorts last, so `alpha` would already have been written by a
      // one-phase implementation before this entry was reached.
      await writeProposal(root, [
        entry('alpha'),
        entry('zulu', { session_id: 'handoff migration' }),
      ]);

      await expect(v2ToV3OpenLoops.run(root)).rejects.toBeInstanceOf(ValidationError);

      expect(await fs.readdir(path.join(root, 'alpha', 'sessions')).catch(() => [])).toEqual([]);
      expect(await exists(path.join(root, 'alpha', 'handoff.md'))).toBe(true);
      const brief = await fs.readFile(path.join(root, 'alpha', 'brief.md'), 'utf8');
      expect(brief).not.toContain('task_seq');
    });
  });

  it('aborts before writing when a later entry fails session-schema validation', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', { taskIds: ['XX-1'] });
      await scaffold(root, 'zulu', { taskIds: ['XX-2'] });
      // Duplicate next_steps ids pass the per-entry proposal schema and are
      // only caught by SessionFrontmatterSchema — i.e. in phase one proper,
      // after the proposal itself has loaded cleanly.
      await writeProposal(root, [
        entry('alpha'),
        entry('zulu', {
          next_steps: [
            { id: 'n1', text: 'a', kind: 'prose' },
            { id: 'n1', text: 'b', kind: 'prose' },
          ],
        }),
      ]);

      await expect(v2ToV3OpenLoops.run(root)).rejects.toThrow(/must be unique/);

      expect(await fs.readdir(path.join(root, 'alpha', 'sessions')).catch(() => [])).toEqual([]);
      expect(await exists(path.join(root, 'alpha', 'handoff.md'))).toBe(true);
    });
  });

  it('rejects a proposal naming an initiative that does not exist', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha');
      await writeProposal(root, [entry('ghost')]);
      await expect(v2ToV3OpenLoops.run(root)).rejects.toThrow(/do not exist: ghost/);
    });
  });

  it('archives the handoff and deletes the original', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', { handoff: '# Current state\n\nkeep me\n' });
      await writeProposal(root, [entry('alpha')]);

      await v2ToV3OpenLoops.run(root);

      expect(await exists(path.join(root, 'alpha', 'handoff.md'))).toBe(false);
      const archived = await fs.readFile(
        path.join(root, 'alpha', 'sources', 'handoff-archive.md'),
        'utf8',
      );
      expect(archived).toContain('keep me');
    });
  });

  it('leaves the handoff alone when an archive already exists', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha');
      await fs.writeFile(
        path.join(root, 'alpha', 'sources', 'handoff-archive.md'),
        'operator split in progress\n',
        'utf8',
      );
      await writeProposal(root, [entry('alpha')]);

      const plan = await planV2ToV3(root);
      expect(plan.initiatives[0].handoff).toBe('archive-exists');

      await v2ToV3OpenLoops.run(root);
      expect(await exists(path.join(root, 'alpha', 'handoff.md'))).toBe(true);
      expect(
        await fs.readFile(path.join(root, 'alpha', 'sources', 'handoff-archive.md'), 'utf8'),
      ).toBe('operator split in progress\n');
    });
  });

  it('skips an uncovered initiative loudly but still archives its handoff', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha');
      await scaffold(root, 'denver-rezzy');
      await writeProposal(root, [entry('alpha')]);

      const plan = await planV2ToV3(root);
      const rezzy = plan.initiatives.find((i) => i.slug === 'denver-rezzy')!;
      expect(rezzy.sessions).toEqual([]);
      expect(rezzy.uncoveredReason).toMatch(/no entry in the migration proposal/);

      await v2ToV3OpenLoops.run(root);
      expect(await exists(path.join(root, 'denver-rezzy', 'sessions', `${STEM}.md`))).toBe(false);
      expect(await exists(path.join(root, 'denver-rezzy', 'sources', 'handoff-archive.md'))).toBe(
        true,
      );
    });
  });
});

describe('the bundled proposal', () => {
  it('validates against ProposalSchema and covers every live initiative', () => {
    const parsed = ProposalSchema.parse(V3_OPEN_LOOPS_PROPOSAL);
    expect(parsed.initiatives).toHaveLength(17);
    // 97 after the 2026-07-29 AW-65 refresh (was 99): active-work's merged-PR
    // loop and claude-channels' unverifiable "Service Steps" loop dropped,
    // voltras' two already-done loops dropped, and CC-31, R-44 and
    // VMCP-01.72 added.
    const totalLoops = parsed.initiatives.reduce((n, i) => n + i.next_steps.length, 0);
    expect(totalLoops).toBe(97);
    // Slugs unique, ids unique within a session, session_ids kebab-case.
    expect(new Set(parsed.initiatives.map((i) => i.slug)).size).toBe(17);
    for (const initiative of parsed.initiatives) {
      const ids = initiative.next_steps.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // A `kind: pr` loop can never close on its own: bootstrap leaves
  // `mergedPrs` unsupplied so derivation stays offline, so `isAutoResolved`
  // only ever fires for `kind: task`. The proposal shipped one such loop
  // (active-work → PR #56); the PR merged before the migration ran and the
  // loop would have hung in the ledger forever. Carry PR work as prose.
  it('carries no kind:pr loops, which could never auto-resolve', () => {
    const parsed = ProposalSchema.parse(V3_OPEN_LOOPS_PROPOSAL);
    const prLoops = parsed.initiatives.flatMap((i) =>
      i.next_steps.filter((n) => n.kind === 'pr').map((n) => `${i.slug}#${n.id}`),
    );
    expect(prLoops).toEqual([]);
  });

  it('marks herald as the one abandoned-on-arrival loop', () => {
    const parsed = ProposalSchema.parse(V3_OPEN_LOOPS_PROPOSAL);
    const abandoned = parsed.initiatives.flatMap((i) =>
      i.next_steps.filter((n) => n.abandoned !== undefined).map((n) => `${i.slug}#${n.id}`),
    );
    expect(abandoned).toEqual(['herald#n1']);
    expect(parsed.abandoned_at).toBe('2026-07-28T18:00:00Z');
  });

  it('rejects an abandoned marker without abandoned_at', () => {
    const bad = { initiatives: [entry('a', { next_steps: [ABANDONED_STEP] })] };
    expect(() => ProposalSchema.parse(bad)).toThrow(/abandoned_at is required/);
  });

  it('rejects an abandoned_at that is not strictly after the opening session', () => {
    const bad = {
      abandoned_at: ENDED,
      initiatives: [entry('a', { next_steps: [ABANDONED_STEP] })],
    };
    expect(() => ProposalSchema.parse(bad)).toThrow(/must be strictly after/);
  });
});

describe('abandoned-on-arrival loops', () => {
  const ABANDONED_AT = '2026-07-28T18:00:00Z';
  const ABANDON_STEM = '2026-07-28-1800-handoff-migration-abandonment';

  async function migrateWithAbandonment(root: string): Promise<void> {
    await scaffold(root, 'herald');
    const file = path.join(root, 'proposal.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        abandoned_at: ABANDONED_AT,
        initiatives: [
          entry('herald', {
            next_steps: [
              { id: 'n1', text: 'Chase the lapsed credit', kind: 'prose', ...ABANDONED_STEP_EXTRA },
              { id: 'n2', text: 'Still live work', kind: 'prose' },
            ],
          }),
        ],
      }),
      'utf8',
    );
    process.env[PROPOSAL_PATH_ENV] = file;
    await v2ToV3OpenLoops.run(root);
  }

  it('writes two sessions, the second strictly later, closing only the dead loop', async () => {
    await withEmptyActiveRoot(async (root) => {
      await migrateWithAbandonment(root);

      const files = (await fs.readdir(path.join(root, 'herald', 'sessions'))).sort();
      expect(files).toEqual([`${STEM}.md`, `${ABANDON_STEM}.md`].sort());

      const abandon = await fs.readFile(
        path.join(root, 'herald', 'sessions', `${ABANDON_STEM}.md`),
        'utf8',
      );
      expect(abandon).toContain('track: sidecar');
      expect(abandon).toContain(`ref: ${STEM}#n1`);
      expect(abandon).toContain('outcome: abandoned');
      expect(abandon).toContain('window closed long before the migration');
      expect(abandon).not.toContain('no_loops');
      // The closing session opens nothing of its own.
      expect(abandon).toContain('next_steps: []');

      // Strictly later, as the resolve ordering rule requires.
      expect(new Date(ABANDONED_AT).getTime()).toBeGreaterThan(new Date(ENDED).getTime());
    });
  });

  it('leaves the abandoned loop closed and the live one open', async () => {
    await withEmptyActiveRoot(async (root) => {
      await migrateWithAbandonment(root);

      const loops = await deriveOpenLoops(path.join(root, 'herald'), {
        now: new Date('2026-07-29T00:00:00Z'),
      });
      expect(loops.map((l) => l.ref)).toEqual([`${STEM}#n2`]);

      // The close landed cleanly — no ref pointing at nothing, nothing filed
      // by a session that is not strictly prior.
      const dangling = await findDanglingResolves(path.join(root, 'herald'));
      expect(dangling).toEqual([]);
    });
  });

  it('does not leak the proposal-only `abandoned` key into the session file', async () => {
    await withEmptyActiveRoot(async (root) => {
      await migrateWithAbandonment(root);
      const open = await fs.readFile(path.join(root, 'herald', 'sessions', `${STEM}.md`), 'utf8');
      expect(open).not.toContain('abandoned:');
    });
  });

  it('is idempotent with both sessions present', async () => {
    await withEmptyActiveRoot(async (root) => {
      await migrateWithAbandonment(root);
      const before = (await fs.readdir(path.join(root, 'herald', 'sessions'))).sort();

      await v2ToV3OpenLoops.run(root);
      await v2ToV3OpenLoops.run(root);

      expect((await fs.readdir(path.join(root, 'herald', 'sessions'))).sort()).toEqual(before);
      const loops = await deriveOpenLoops(path.join(root, 'herald'), {
        now: new Date('2026-07-29T00:00:00Z'),
      });
      expect(loops.map((l) => l.ref)).toEqual([`${STEM}#n2`]);
    });
  });

  it('completes a run interrupted between the two sessions', async () => {
    await withEmptyActiveRoot(async (root) => {
      await migrateWithAbandonment(root);
      // Simulate a crash after the opening session but before the closing one.
      await fs.rm(path.join(root, 'herald', 'sessions', `${ABANDON_STEM}.md`));

      await v2ToV3OpenLoops.run(root);

      expect(await exists(path.join(root, 'herald', 'sessions', `${ABANDON_STEM}.md`))).toBe(true);
      const loops = await deriveOpenLoops(path.join(root, 'herald'), {
        now: new Date('2026-07-29T00:00:00Z'),
      });
      expect(loops.map((l) => l.ref)).toEqual([`${STEM}#n2`]);
    });
  });
});

describe('brief field repairs', () => {
  it("repairs health's out-of-enum state before the task_seq backfill", async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'health', { taskIds: ['XX-7'], state: 'active' });
      await writeProposal(root, []);

      const plan = await planV2ToV3(root);
      expect(plan.initiatives[0].brief!.repairs).toEqual([
        "state 'active' (not in the enum) -> 'focused', rank 11",
      ]);
      expect(plan.initiatives[0].brief!.taskSeq).toBe(7);
      expect(plan.initiatives[0].briefBlocked).toBeUndefined();

      await v2ToV3OpenLoops.run(root);

      const brief = await fs.readFile(path.join(root, 'health', 'brief.md'), 'utf8');
      expect(brief).toContain('state: focused');
      expect(brief).toContain('rank: 11');
      expect(brief).toContain('task_seq: 7');
      expect(brief).toContain("updated: '2026-05-12'");
    });
  });

  it('leaves a hand-fixed state alone and is a no-op on a re-run', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'health', { taskIds: ['XX-7'], state: 'backburner' });
      await writeProposal(root, []);

      await v2ToV3OpenLoops.run(root);
      const after = await fs.readFile(path.join(root, 'health', 'brief.md'), 'utf8');
      expect(after).toContain('state: backburner');
      expect(after).not.toContain('rank: 11');

      await v2ToV3OpenLoops.run(root);
      expect(await fs.readFile(path.join(root, 'health', 'brief.md'), 'utf8')).toBe(after);
    });
  });

  it('reports, rather than throws, on a brief broken in a way it cannot repair', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', { taskIds: ['XX-2'], state: 'nonsense' });
      await writeProposal(root, []);

      const plan = await planV2ToV3(root);
      expect(plan.initiatives[0].brief).toBeNull();
      expect(plan.initiatives[0].briefBlocked).toMatch(/brief\.md is invalid/);

      await expect(v2ToV3OpenLoops.run(root)).resolves.toBeUndefined();
    });
  });
});

describe('task_seq backfill', () => {
  it('seeds the high-water mark from the highest id on disk, archive included', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', {
        taskIds: ['XX-2', 'XX-9'],
        archivedTaskIds: ['XX-14'],
      });
      await writeProposal(root, []);

      await v2ToV3OpenLoops.run(root);

      const brief = await fs.readFile(path.join(root, 'alpha', 'brief.md'), 'utf8');
      expect(brief).toContain('task_seq: 14');
      expect(brief).toContain("updated: '2026-05-12'");
    });
  });

  it('never lowers an existing task_seq', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha', { taskIds: ['XX-2'], taskSeq: 40 });
      await writeProposal(root, []);

      await v2ToV3OpenLoops.run(root);

      expect(await fs.readFile(path.join(root, 'alpha', 'brief.md'), 'utf8')).toContain(
        'task_seq: 40',
      );
    });
  });

  it('writes nothing when no task has ever been issued', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha');
      await writeProposal(root, []);

      const plan = await planV2ToV3(root);
      expect(plan.initiatives[0].brief).toBeNull();

      await v2ToV3OpenLoops.run(root);
      expect(await fs.readFile(path.join(root, 'alpha', 'brief.md'), 'utf8')).not.toContain(
        'task_seq',
      );
    });
  });
});

describe('known malformed-session repairs', () => {
  const AUDIOBOOK = path.join(
    'audiobook',
    'sessions',
    '2026-07-23-0549-2026-07-26-book1-m4b-packaging.md',
  );
  const ARCHIVED = path.join(
    'voltras-workspace',
    'sessions',
    'ARCHIVED-handoff-through-2026-07-15.md',
  );

  async function scaffoldMalformed(root: string): Promise<void> {
    await scaffold(root, 'audiobook');
    await scaffold(root, 'voltras-workspace');
    await fs.mkdir(path.join(root, 'audiobook', 'sessions'), { recursive: true });
    await fs.mkdir(path.join(root, 'voltras-workspace', 'sessions'), { recursive: true });
    await fs.writeFile(
      path.join(root, AUDIOBOOK),
      [
        '---',
        'session_id: book1-m4b-packaging',
        "started: '2026-07-23T05:49:00Z'",
        "ended: '2026-07-23T06:49:00Z'",
        'track: feat/tts-quality',
        '---',
        '',
        'Packaged book 1.',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, ARCHIVED),
      '# Archived handoff\n\nNo frontmatter here.\n',
      'utf8',
    );
  }

  it('retracks the branch-named track to adhoc and relocates the archived handoff', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffoldMalformed(root);
      await writeProposal(root, []);

      await v2ToV3OpenLoops.run(root);

      expect(await fs.readFile(path.join(root, AUDIOBOOK), 'utf8')).toContain('track: adhoc');
      expect(await exists(path.join(root, ARCHIVED))).toBe(false);
      expect(
        await exists(
          path.join(root, 'voltras-workspace', 'sources', 'ARCHIVED-handoff-through-2026-07-15.md'),
        ),
      ).toBe(true);
    });
  });

  it('leaves both initiatives free of session-file issues afterwards', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffoldMalformed(root);
      await writeProposal(root, []);

      await v2ToV3OpenLoops.run(root);

      for (const slug of ['audiobook', 'voltras-workspace']) {
        const issues = await findSessionIssues(path.join(root, slug));
        expect(issues.malformed).toEqual([]);
      }
    });
  });

  it('is a no-op on a second run', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffoldMalformed(root);
      await writeProposal(root, []);

      await v2ToV3OpenLoops.run(root);
      const after = await fs.readFile(path.join(root, AUDIOBOOK), 'utf8');

      await v2ToV3OpenLoops.run(root);

      expect(await fs.readFile(path.join(root, AUDIOBOOK), 'utf8')).toBe(after);
      const plan = await planV2ToV3(root);
      expect(plan.repairs.every((r) => r.action === 'skip')).toBe(true);
    });
  });
});
