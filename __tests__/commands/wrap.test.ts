import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import YAML from 'yaml';
import wrap from '../../src/commands/wrap.js';
import { registry } from '../../src/registry/index.js';
import '../../src/commands/index.js'; // populate the registry
import { deriveOpenLoops } from '../../src/sessions/open-loops.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { today } from '../../src/utils/today.js';
import { setGitRunner, resetRunners, type CommandRunner } from '../../src/utils/git-gh.js';
import { expandTilde } from '../../src/utils/paths.js';
import type { CommandContext } from '../../src/registry/index.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

const SLUG = 'sample-initiative';
const STARTED = '2026-05-12T09:00:00Z';
const ENDED = '2026-05-12T10:30:00Z';

/**
 * The one repo the fixture's brief and artifacts both point at. Resolved
 * lazily: the test sandbox rewrites `$HOME` under the runner.
 */
const sampleRepo = (): string => expandTilde('~/code/sample');

/** No repo answers git, so the sweep finds nothing to record. */
const NO_GIT: CommandRunner = () => Promise.resolve({ code: 1, stdout: '', stderr: '' });

/**
 * A `~/code/sample` worktree on an unrecorded branch, dirty and two commits
 * ahead, with one stash. Every other path (including the test runner's own
 * cwd) fails, so the sweep is deterministic.
 */
const GIT_WITH_WORK: CommandRunner = (_bin, args) => {
  const fail = { code: 1, stdout: '', stderr: '' };
  if (args[1] !== sampleRepo()) return Promise.resolve(fail);
  const sub = args.slice(2).join(' ');
  const replies: Array<[string, string]> = [
    ['worktree list', `worktree ${sampleRepo()}\nbranch refs/heads/feat/new-thing\n`],
    ['rev-parse --is-inside-work-tree', 'true\n'],
    ['status --porcelain', ' M a.ts\n M b.ts\n'],
    ['rev-parse --abbrev-ref', 'feat/new-thing\n'],
    ['rev-list --count @{u}..HEAD', '2\n'],
    ['rev-list --count HEAD..@{u}', '0\n'],
    ['rev-list --count HEAD --not --remotes', '2\n'],
    ['stash list', 'abc123\tWIP on feat/new-thing\n'],
  ];
  const hit = replies.find(([prefix]) => sub.startsWith(prefix));
  return Promise.resolve(hit ? { code: 0, stdout: hit[1], stderr: '' } : fail);
};

const NEXT_STEPS = [
  { id: 'n1', text: 'Wire cost rollup into the daemon', kind: 'prose' as const },
  { id: 'n2', text: 'Land the index', kind: 'task' as const, ref: 'SI-1' },
];

const NOTES = [
  {
    kind: 'gotcha' as const,
    title: 'flock is per-initiative',
    body: 'Nesting a second lock on the same slug deadlocks.\n',
    tags: ['locking'],
  },
];

/**
 * Every wrap must answer all three categories; tests that are not about a
 * given category assert it away so the gate under test is the one that fires.
 */
function baseArgs(overrides: Record<string, unknown> = {}) {
  return wrap.args.parse({
    slug: SLUG,
    session_id: 'sess-wrap',
    started: STARTED,
    ended: ENDED,
    body: 'what happened\n',
    no_notes: true,
    no_tasks: true,
    ...overrides,
  });
}

async function readArtifacts(activeRoot: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(activeRoot, SLUG, 'artifacts.yml'), 'utf8');
  return YAML.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  setGitRunner(NO_GIT);
});

afterEach(() => {
  resetRunners();
});

/**
 * Write an earlier session carrying one open loop and return `<stem>#p1` — the
 * only kind of ref a later wrap can legitimately close.
 */
async function seedPriorLoop(
  activeRoot: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const prior = await wrap.run(
    baseArgs({
      session_id: 'sess-prior',
      started: '2026-05-11T09:00:00Z',
      ended: '2026-05-11T10:00:00Z',
      next_steps: [{ id: 'p1', text: 'an earlier loop', kind: 'prose' }],
      ...overrides,
    }),
    makeCtx(activeRoot),
  );
  return `${prior.filename.replace(/\.md$/, '')}#p1`;
}

async function readFrontmatter(file: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(file, 'utf8');
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  return YAML.parse(block?.[1] ?? '') as Record<string, unknown>;
}

describe('wrap', () => {
  it('is the only way to record a session: session.record is gone', () => {
    expect(registry.get('session.record')).toBeUndefined();
    expect(registry.get('wrap')).toBeDefined();
  });

  it('writes the session ledger and bumps brief.updated in one call', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const priorRef = await seedPriorLoop(activeRoot);
      const result = await wrap.run(
        baseArgs({
          next_steps: NEXT_STEPS,
          resolves: [{ ref: priorRef, outcome: 'done' }],
        }),
        makeCtx(activeRoot),
      );

      expect(result.filename).toBe('2026-05-12-0900-sess-wrap.md');
      expect(result.filed.next_steps).toBe(2);
      expect(result.closed.resolves_applied).toBe(1);
      expect(result.resolves_rejected).toEqual([]);
      expect(result.ready_to_end).toBe(true);
      expect(result.updated).toBe(today());

      const frontmatter = await readFrontmatter(result.path);
      expect(frontmatter.next_steps).toEqual(NEXT_STEPS);
      expect(frontmatter.track).toBe('canonical');
      const raw = await fs.readFile(result.path, 'utf8');
      expect(raw).toContain('what happened');

      const brief = await readFrontmatter(path.join(activeRoot, SLUG, 'brief.md'));
      expect(brief.updated).toBe(today());
    });
  });

  it('accepts next_steps and resolves as JSON strings from the CLI', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const priorRef = await seedPriorLoop(activeRoot);
      const result = await wrap.run(
        baseArgs({
          session_id: 'sess-json',
          next_steps: JSON.stringify(NEXT_STEPS),
          resolves: JSON.stringify([{ ref: priorRef, outcome: 'abandoned', note: 'superseded' }]),
        }),
        makeCtx(activeRoot),
      );

      const frontmatter = await readFrontmatter(result.path);
      expect(frontmatter.next_steps).toEqual(NEXT_STEPS);
      expect(frontmatter.resolves).toEqual([
        { ref: priorRef, outcome: 'abandoned', note: 'superseded' },
      ]);
    });
  });

  it('refuses to wrap with an empty ledger, without naming its own bypass', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const sessionsDir = path.join(activeRoot, SLUG, 'sessions');
      const before = await fs.readdir(sessionsDir);

      await expect(wrap.run(baseArgs(), makeCtx(activeRoot))).rejects.toThrow(
        /--next-steps.*--resolves/s,
      );
      // An agent that hits the gate must not be handed the silencer with it.
      await expect(wrap.run(baseArgs(), makeCtx(activeRoot))).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('--no-loops') }),
      );
      expect(await fs.readdir(sessionsDir)).toEqual(before);
    });
  });

  it('records no_loops: true so a deliberate empty ledger is distinguishable', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await wrap.run(baseArgs({ no_loops: true }), makeCtx(activeRoot));
      const frontmatter = await readFrontmatter(result.path);
      expect(frontmatter.next_steps).toEqual([]);
      expect(frontmatter.resolves).toEqual([]);
      expect(frontmatter.no_loops).toBe(true);
      expect(result.updated).toBe(today());
    });
  });

  it('omits no_loops when a ledger is filed', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await wrap.run(
        baseArgs({ session_id: 'sess-marker', next_steps: NEXT_STEPS }),
        makeCtx(activeRoot),
      );
      const frontmatter = await readFrontmatter(result.path);
      expect(frontmatter.no_loops).toBeUndefined();
    });
  });

  it('rejects --no-loops alongside a non-empty ledger', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        wrap.run(
          baseArgs({
            session_id: 'sess-both',
            no_loops: true,
            next_steps: NEXT_STEPS,
          }),
          makeCtx(activeRoot),
        ),
      ).rejects.toThrow(/--no-loops asserts an empty ledger/);
    });
  });

  it('accepts a resolves-only ledger', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const priorRef = await seedPriorLoop(activeRoot);
      const result = await wrap.run(
        baseArgs({
          session_id: 'sess-resolves-only',
          resolves: [{ ref: priorRef, outcome: 'done' }],
        }),
        makeCtx(activeRoot),
      );
      expect(result.filed.next_steps).toBe(0);
      expect(result.closed.resolves_applied).toBe(1);
    });
  });

  it('accepts --track adhoc', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await wrap.run(
        baseArgs({ session_id: 'sess-adhoc', track: 'adhoc', no_loops: true }),
        makeCtx(activeRoot),
      );
      const frontmatter = await readFrontmatter(result.path);
      expect(frontmatter.track).toBe('adhoc');
    });
  });

  it('feeds the loops it writes straight into deriveOpenLoops', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const written = await wrap.run(
        baseArgs({ session_id: 'sess-loops', next_steps: NEXT_STEPS }),
        makeCtx(activeRoot),
      );
      const stem = written.filename.replace(/\.md$/, '');

      const loops = await deriveOpenLoops(path.join(activeRoot, SLUG), {
        now: new Date('2026-05-14T10:30:00Z'),
      });
      expect(loops.map((l) => l.ref)).toEqual([`${stem}#n1`, `${stem}#n2`]);
      expect(loops[0]?.ageDays).toBe(2);
    });
  });

  it('writes nothing when the ledger is invalid', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const sessionsDir = path.join(activeRoot, SLUG, 'sessions');
      const before = await fs.readdir(sessionsDir);
      const briefBefore = await readFrontmatter(path.join(activeRoot, SLUG, 'brief.md'));

      await expect(
        wrap.run(
          baseArgs({
            session_id: 'sess-bad',
            // Abandoned without a note — rejected by the session schema.
            resolves: [{ ref: 'aaa#n1', outcome: 'abandoned' }],
          }),
          makeCtx(activeRoot),
        ),
      ).rejects.toThrow(/Frontmatter validation failed/);

      expect(await fs.readdir(sessionsDir)).toEqual(before);
      const briefAfter = await readFrontmatter(path.join(activeRoot, SLUG, 'brief.md'));
      expect(briefAfter.updated).toBe(briefBefore.updated);
    });
  });

  it('rolls the session file back when the brief write fails', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const briefPath = path.join(activeRoot, SLUG, 'brief.md');
      // Invalid brief frontmatter: the bump re-validates and throws.
      await fs.writeFile(briefPath, '---\ntitle: Broken\n---\n\nbody\n', 'utf8');
      const sessionsDir = path.join(activeRoot, SLUG, 'sessions');
      const before = await fs.readdir(sessionsDir);

      await expect(
        wrap.run(baseArgs({ session_id: 'sess-rollback', no_loops: true }), makeCtx(activeRoot)),
      ).rejects.toThrow(/Frontmatter validation failed/);

      expect(await fs.readdir(sessionsDir)).toEqual(before);
    });
  });

  it('rejects an unknown initiative before touching anything', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        wrap.run(baseArgs({ slug: 'no-such-initiative' }), makeCtx(activeRoot)),
      ).rejects.toThrow(/Initiative not found/);
    });
  });

  it('rejects malformed JSON in --next-steps', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        wrap.run(
          baseArgs({ session_id: 'sess-badjson', next_steps: 'not json' }),
          makeCtx(activeRoot),
        ),
      ).rejects.toThrow(/must be a JSON array/);
    });
  });

  it('rejects when neither --body nor --body-file is provided', () => {
    expect(() =>
      wrap.args.parse({
        slug: SLUG,
        session_id: 'sess-nobody',
        started: STARTED,
        ended: ENDED,
      }),
    ).toThrow(/Exactly one of --body or --body-file/);
  });

  // AW-46: `resolves.ref` is `<stem>#<id>`, so an id or session_id carrying `#`,
  // whitespace or `/` yields a loop that no valid resolve can ever close.
  describe('id character sets (AW-46)', () => {
    it.each(['step 1', 'a#b', 'a/b', 'with\ttab'])('rejects a next_steps id of %j', async (id) => {
      const steps = [{ id, text: 'x', kind: 'prose' }];
      // Structured (MCP) callers are rejected at parse...
      expect(() => baseArgs({ next_steps: steps })).toThrow(/next_steps id must not contain/);
      // ...and the CLI's JSON-string path writes nothing either.
      await withTempActiveRoot(async (activeRoot) => {
        const sessionsDir = path.join(activeRoot, SLUG, 'sessions');
        const before = await fs.readdir(sessionsDir);

        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-badid',
              next_steps: JSON.stringify(steps),
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/next_steps id must not contain/);
        expect(await fs.readdir(sessionsDir)).toEqual(before);
      });
    });

    it.each(['sess 1', 'a#b', '../escape', 'nested/id'])(
      'rejects a session_id of %j',
      (session_id) => {
        expect(() => baseArgs({ session_id, no_loops: true })).toThrow(
          /session_id must not contain/,
        );
      },
    );

    it('still accepts the free-form slug session_ids already in use', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const result = await wrap.run(
          baseArgs({
            session_id: '2026-07-26-book1-m4b-packaging',
            no_loops: true,
          }),
          makeCtx(activeRoot),
        );
        expect(result.filename).toBe('2026-05-12-0900-2026-07-26-book1-m4b-packaging.md');
      });
    });
  });

  // Migrated from the deleted `session.record` command, which shared this path.
  describe('session file writing', () => {
    it('reads the body from --body-file when --body is omitted', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const bodyPath = path.join(activeRoot, 'body.md');
        await fs.writeFile(bodyPath, 'from-file body\n- bullet\n', 'utf8');
        const result = await wrap.run(
          wrap.args.parse({
            slug: SLUG,
            session_id: 'body-from-file',
            started: STARTED,
            ended: ENDED,
            body_file: bodyPath,
            no_loops: true,
            no_notes: true,
            no_tasks: true,
          }),
          makeCtx(activeRoot),
        );
        const raw = await fs.readFile(result.path, 'utf8');
        expect(raw).toContain('from-file body');
        expect(raw).toContain('- bullet');
      });
    });

    it('rejects when both --body and --body-file are provided', () => {
      expect(() => baseArgs({ body_file: '/tmp/whatever.md' })).toThrow(/mutually exclusive/);
    });

    it('rejects an invalid track value', () => {
      expect(() => baseArgs({ track: 'nope', no_loops: true })).toThrow();
    });

    it('rejects ended < started', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        await expect(
          wrap.run(
            baseArgs({
              session_id: 'reverse',
              started: ENDED,
              ended: STARTED,
              no_loops: true,
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/Frontmatter validation failed/);
      });
    });
  });

  // AW-53: a `resolves` ref that closes nothing used to be counted as applied
  // and exit 0, so the agent that filed it never learned the close missed.
  describe('rejected resolves (AW-53)', () => {
    it('reports a ref that names no loop, and still writes the session', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const ctx = makeCtx(activeRoot);
        const result = await wrap.run(
          baseArgs({
            session_id: 'sess-missing',
            resolves: [{ ref: 'no-such-stem#n1', outcome: 'done' }],
          }),
          ctx,
        );
        expect(result.resolves_rejected).toEqual([{ ref: 'no-such-stem#n1', kind: 'missing' }]);
        expect(ctx.warnings.join('\n')).toMatch(/no-such-stem#n1 \(missing\)/);

        // Write-and-report: the narrative survives the bad ref.
        const written = path.join(activeRoot, SLUG, 'sessions', '2026-05-12-0900-sess-missing.md');
        expect(await readFrontmatter(written)).toMatchObject({
          session_id: 'sess-missing',
        });
      });
    });

    it('reports a loop opened by a session that did not end earlier', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const tiedRef = await seedPriorLoop(activeRoot, {
          session_id: 'sess-tied',
          started: STARTED,
          ended: ENDED,
        });

        const ctx = makeCtx(activeRoot);
        const result = await wrap.run(
          baseArgs({
            session_id: 'sess-parallel',
            resolves: [{ ref: tiedRef, outcome: 'done' }],
          }),
          ctx,
        );
        expect(result.resolves_rejected).toEqual([{ ref: tiedRef, kind: 'not-prior' }]);
        expect(ctx.warnings.join('\n')).toMatch(/\(not-prior\)/);
      });
    });

    it('reports a session trying to close its own loop', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const ctx = makeCtx(activeRoot);
        const result = await wrap.run(
          baseArgs({
            session_id: 'sess-self',
            next_steps: [{ id: 'n1', text: 'mine', kind: 'prose' }],
            resolves: [{ ref: '2026-05-12-0900-sess-self#n1', outcome: 'done' }],
          }),
          ctx,
        );
        expect(result.resolves_rejected).toEqual([
          { ref: '2026-05-12-0900-sess-self#n1', kind: 'self' },
        ]);
        expect(ctx.warnings.join('\n')).toMatch(/2026-05-12-0900-sess-self#n1 \(self\)/);
      });
    });

    it('counts only the refs that closed a loop when some are bad', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const priorRef = await seedPriorLoop(activeRoot);
        const ctx = makeCtx(activeRoot);
        const result = await wrap.run(
          baseArgs({
            session_id: 'sess-mixed',
            resolves: [
              { ref: priorRef, outcome: 'done' },
              { ref: 'typo#p1', outcome: 'done' },
            ],
          }),
          ctx,
        );
        expect(result.closed).toEqual({ resolves_applied: 1 });
        expect(result.ready_to_end).toBe(false);
        expect(ctx.warnings.join('\n')).toMatch(/1 of 2 --resolves entries closed no loop/);
      });
    });

    it('leaves the resolved loop closed for deriveOpenLoops', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const priorRef = await seedPriorLoop(activeRoot);
        await wrap.run(
          baseArgs({
            session_id: 'sess-closer',
            resolves: [{ ref: priorRef, outcome: 'done' }],
          }),
          makeCtx(activeRoot),
        );

        const loops = await deriveOpenLoops(path.join(activeRoot, SLUG), {
          now: new Date('2026-05-14T10:30:00Z'),
        });
        expect(loops.map((l) => l.ref)).not.toContain(priorRef);
      });
    });
  });

  // The point of wrap: a session that produced notes or tasks and did not say
  // so is indistinguishable from one that produced none, and the knowledge is
  // gone the moment the process exits.
  describe('every category needs an explicit answer', () => {
    it('refuses without an answer for notes, without naming its own bypass', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const sessionsDir = path.join(activeRoot, SLUG, 'sessions');
        const before = await fs.readdir(sessionsDir);
        const args = () =>
          baseArgs({ no_notes: undefined, no_loops: true, session_id: 'sess-nonotes' });

        await expect(wrap.run(args(), makeCtx(activeRoot))).rejects.toThrow(
          /durable notes.*--notes/s,
        );
        await expect(wrap.run(args(), makeCtx(activeRoot))).rejects.toThrow(
          expect.objectContaining({
            message: expect.not.stringContaining('--no-notes'),
          }),
        );
        expect(await fs.readdir(sessionsDir)).toEqual(before);
      });
    });

    it('refuses without an answer for tasks, without naming its own bypass', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const args = () =>
          baseArgs({ no_tasks: undefined, no_loops: true, session_id: 'sess-notasks' });

        await expect(wrap.run(args(), makeCtx(activeRoot))).rejects.toThrow(
          /tasks.*--tasks-filed/s,
        );
        await expect(wrap.run(args(), makeCtx(activeRoot))).rejects.toThrow(
          expect.objectContaining({
            message: expect.not.stringContaining('--no-tasks'),
          }),
        );
      });
    });

    it('rejects --no-notes alongside --notes', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        await expect(
          wrap.run(
            baseArgs({ session_id: 'sess-bothnotes', no_loops: true, notes: NOTES }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/--no-notes asserts/);
      });
    });

    it('rejects --no-tasks alongside --tasks-filed', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-bothtasks',
              no_loops: true,
              tasks_filed: ['SI-1'],
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/--no-tasks asserts/);
      });
    });
  });

  describe('--tasks-filed', () => {
    it('rejects an id that names no task, and writes nothing', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const sessionsDir = path.join(activeRoot, SLUG, 'sessions');
        const before = await fs.readdir(sessionsDir);

        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-fake-task',
              no_loops: true,
              no_tasks: undefined,
              tasks_filed: ['SI-1', 'SI-999'],
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/SI-999/);
        expect(await fs.readdir(sessionsDir)).toEqual(before);
      });
    });

    it('is honest that it can only check existence', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-honest',
              no_loops: true,
              no_tasks: undefined,
              tasks_filed: ['SI-999'],
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/not verifiable/);
      });
    });

    it('counts ids that exist, including from a JSON string', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const result = await wrap.run(
          baseArgs({
            session_id: 'sess-real-tasks',
            no_loops: true,
            no_tasks: undefined,
            tasks_filed: JSON.stringify(['SI-1', 'SI-2']),
          }),
          makeCtx(activeRoot),
        );
        expect(result.filed.tasks).toBe(2);
      });
    });
  });

  describe('--notes', () => {
    it('writes each note under sources/notes/ and counts it in the receipt', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const result = await wrap.run(
          baseArgs({
            session_id: 'sess-notes',
            no_loops: true,
            no_notes: undefined,
            notes: NOTES,
          }),
          makeCtx(activeRoot),
        );

        expect(result.filed.notes).toBe(1);
        const notesDir = path.join(activeRoot, SLUG, 'sources', 'notes');
        const files = await fs.readdir(notesDir);
        expect(files).toEqual([`${today()}-flock-is-per-initiative.md`]);
        const frontmatter = await readFrontmatter(path.join(notesDir, files[0]!));
        expect(frontmatter).toMatchObject({
          kind: 'gotcha',
          title: 'flock is per-initiative',
          created: today(),
          tags: ['locking'],
        });
        const raw = await fs.readFile(path.join(notesDir, files[0]!), 'utf8');
        expect(raw).toContain('Nesting a second lock');
        expect(result.files_updated).toContain(path.join('sources', 'notes', files[0]!));
      });
    });

    it('rolls the session file back when a note cannot be written', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        // `sources/notes` occupied by a file: the note write throws on mkdir.
        await fs.writeFile(
          path.join(activeRoot, SLUG, 'sources', 'notes'),
          'not a directory\n',
          'utf8',
        );
        const sessionsDir = path.join(activeRoot, SLUG, 'sessions');
        const before = await fs.readdir(sessionsDir);

        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-note-fail',
              no_loops: true,
              no_notes: undefined,
              notes: NOTES,
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow();
        expect(await fs.readdir(sessionsDir)).toEqual(before);
      });
    });
  });

  describe('auto-recorded git state', () => {
    it('appends unrecorded worktrees, branches and stashes to artifacts.yml', async () => {
      // The fixture registers ~/code/sample, so point the sweep at a linked
      // worktree it has never seen — otherwise there is nothing left to append
      // and the test would pass without exercising the write (AW-67).
      const LINKED = '/tmp/wt-unregistered';
      setGitRunner((bin, args) => {
        const sub = args.slice(2).join(' ');
        if (args[1] === sampleRepo() && sub.startsWith('worktree list')) {
          return Promise.resolve({
            code: 0,
            stdout: `worktree ${LINKED}\nbranch refs/heads/feat/new-thing\n`,
            stderr: '',
          });
        }
        return GIT_WITH_WORK(
          bin,
          args[1] === LINKED ? [args[0]!, sampleRepo(), ...args.slice(2)] : args,
        );
      });
      await withTempActiveRoot(async (activeRoot) => {
        const ctx = makeCtx(activeRoot);
        const result = await wrap.run(baseArgs({ session_id: 'sess-sweep', no_loops: true }), ctx);

        expect(result.filed).toMatchObject({ worktrees: 1, branches: 1, stashes: 1 });
        expect(result.files_updated).toContain('artifacts.yml');

        const artifacts = await readArtifacts(activeRoot);
        expect(artifacts.worktrees).toEqual([
          // The registered worktree survives; the swept one is appended.
          { path: '~/code/sample', repo: '~/code/sample', name: 'main', default: true },
          { path: LINKED, repo: '~/code/sample', branch: 'feat/new-thing' },
        ]);
        expect(artifacts.branches).toContainEqual({
          repo: '~/code/sample',
          name: 'feat/new-thing',
        });
        expect(artifacts.stashes).toEqual([
          { repo: '~/code/sample', label: 'WIP on feat/new-thing', sha: 'abc123' },
        ]);
        // Uncommitted and unpushed work cannot be recorded anywhere, so it is
        // reported instead of silently dropped.
        expect(ctx.warnings.join('\n')).toMatch(/2 file\(s\) changed/);
        expect(ctx.warnings.join('\n')).toMatch(/2 commit\(s\) ahead/);
      });
    });

    // AW-73: `git status` failing used to read as a clean tree, so wrap said
    // nothing at all about a worktree that may have held uncommitted work.
    it('warns that a tree is unreadable rather than inventing a file count', async () => {
      const gitStatusBroken: CommandRunner = (bin, args) =>
        args.slice(2).join(' ').startsWith('status --porcelain')
          ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal' })
          : GIT_WITH_WORK(bin, args);
      setGitRunner(gitStatusBroken);

      await withTempActiveRoot(async (activeRoot) => {
        const ctx = makeCtx(activeRoot);
        await wrap.run(baseArgs({ session_id: 'sess-unreadable', no_loops: true }), ctx);
        const warnings = ctx.warnings.join('\n');
        expect(warnings).toMatch(/Could not read the working tree/);
        expect(warnings).not.toMatch(/file\(s\) changed/);
      });
    });

    it('records nothing and refuses nothing when there is nothing to record', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const ctx = makeCtx(activeRoot);
        const result = await wrap.run(baseArgs({ session_id: 'sess-clean', no_loops: true }), ctx);
        expect(result.filed).toMatchObject({ worktrees: 0, branches: 0, stashes: 0 });
        expect(result.files_updated).toEqual(['brief.md']);
        expect(ctx.warnings).toEqual([]);
      });
    });

    it('warns instead of failing when the sweep itself cannot run', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        await fs.writeFile(
          path.join(activeRoot, SLUG, 'artifacts.yml'),
          'branches: "not a list"\n',
          'utf8',
        );
        const ctx = makeCtx(activeRoot);
        const result = await wrap.run(
          baseArgs({ session_id: 'sess-badartifacts', no_loops: true }),
          ctx,
        );
        expect(result.ready_to_end).toBe(true);
        expect(ctx.warnings.join('\n')).toMatch(/Could not sweep git state/);
      });
    });
  });

  it('reports a complete receipt of everything filed', async () => {
    setGitRunner(GIT_WITH_WORK);
    await withTempActiveRoot(async (activeRoot) => {
      const priorRef = await seedPriorLoop(activeRoot);
      const result = await wrap.run(
        baseArgs({
          session_id: 'sess-receipt',
          next_steps: NEXT_STEPS,
          resolves: [{ ref: priorRef, outcome: 'done' }],
          no_notes: undefined,
          notes: NOTES,
          no_tasks: undefined,
          tasks_filed: ['SI-1'],
        }),
        makeCtx(activeRoot),
      );

      expect(result.ready_to_end).toBe(true);
      expect(result.filed).toEqual({
        next_steps: 2,
        notes: 1,
        tasks: 1,
        // The prior wrap already recorded this repo's state.
        worktrees: 0,
        branches: 0,
        stashes: 0,
      });
      expect(result.closed).toEqual({ resolves_applied: 1 });
    });
  });

  it('reports ready_to_end false when a resolve closed nothing', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const ctx = makeCtx(activeRoot);
      const result = await wrap.run(
        baseArgs({
          session_id: 'sess-notready',
          resolves: [{ ref: 'no-such-stem#n1', outcome: 'done' }],
        }),
        ctx,
      );

      // The receipt must survive the rejection: throwing here discarded the
      // one result the caller needed, leaving the rejection readable only by
      // parsing an error string.
      expect(result.ready_to_end).toBe(false);
      expect(result.resolves_rejected).toEqual([{ ref: 'no-such-stem#n1', kind: 'missing' }]);
      expect(result.closed).toEqual({ resolves_applied: 0 });
      expect(ctx.warnings.join('\n')).toMatch(/closed no loop/);
    });
  });

  it('serializes concurrent wraps on the initiative lock', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const results = await Promise.all([
        wrap.run(baseArgs({ session_id: 'race', no_loops: true }), makeCtx(activeRoot)),
        wrap.run(baseArgs({ session_id: 'race', no_loops: true }), makeCtx(activeRoot)),
      ]);

      const filenames = results.map((r) => r.filename).sort();
      expect(filenames).toEqual(['2026-05-12-0900-race-1.md', '2026-05-12-0900-race.md']);
    });
  });
});
