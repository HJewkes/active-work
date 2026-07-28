import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import wrap from '../../src/commands/wrap.js';
import { registry } from '../../src/registry/index.js';
import '../../src/commands/index.js'; // populate the registry
import { deriveOpenLoops } from '../../src/sessions/open-loops.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { today } from '../../src/utils/today.js';
import type { CommandContext } from '../../src/registry/index.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

const SLUG = 'sample-initiative';
const STARTED = '2026-05-12T09:00:00Z';
const ENDED = '2026-05-12T10:30:00Z';

const NEXT_STEPS = [
  { id: 'n1', text: 'Wire cost rollup into the daemon', kind: 'prose' as const },
  { id: 'n2', text: 'Land the index', kind: 'task' as const, ref: 'SI-1' },
];

function baseArgs(overrides: Record<string, unknown> = {}) {
  return wrap.args.parse({
    slug: SLUG,
    session_id: 'sess-wrap',
    started: STARTED,
    ended: ENDED,
    body: 'what happened\n',
    ...overrides,
  });
}

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
      expect(result.next_steps).toBe(2);
      expect(result.resolves_applied).toBe(1);
      expect(result.resolves_rejected).toEqual([]);
      expect(result.updated).toBe(today());

      const frontmatter = await readFrontmatter(result.path);
      expect(frontmatter.next_steps).toEqual(NEXT_STEPS);
      expect(frontmatter.track).toBe('canonical');
      const raw = await fs.readFile(result.path, 'utf8');
      expect(raw).toContain('what happened');

      const brief = await readFrontmatter(
        path.join(activeRoot, SLUG, 'brief.md'),
      );
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
          resolves: JSON.stringify([
            { ref: priorRef, outcome: 'abandoned', note: 'superseded' },
          ]),
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
      const result = await wrap.run(
        baseArgs({ no_loops: true }),
        makeCtx(activeRoot),
      );
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
      expect(result.next_steps).toBe(0);
      expect(result.resolves_applied).toBe(1);
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
      const briefBefore = await readFrontmatter(
        path.join(activeRoot, SLUG, 'brief.md'),
      );

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
      const briefAfter = await readFrontmatter(
        path.join(activeRoot, SLUG, 'brief.md'),
      );
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
        wrap.run(
          baseArgs({ session_id: 'sess-rollback', no_loops: true }),
          makeCtx(activeRoot),
        ),
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
    it.each(['step 1', 'a#b', 'a/b', 'with\ttab'])(
      'rejects a next_steps id of %j',
      async (id) => {
        const steps = [{ id, text: 'x', kind: 'prose' }];
        // Structured (MCP) callers are rejected at parse...
        expect(() => baseArgs({ next_steps: steps })).toThrow(
          /next_steps id must not contain/,
        );
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
      },
    );

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
        expect(result.filename).toBe(
          '2026-05-12-0900-2026-07-26-book1-m4b-packaging.md',
        );
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
          }),
          makeCtx(activeRoot),
        );
        const raw = await fs.readFile(result.path, 'utf8');
        expect(raw).toContain('from-file body');
        expect(raw).toContain('- bullet');
      });
    });

    it('rejects when both --body and --body-file are provided', () => {
      expect(() => baseArgs({ body_file: '/tmp/whatever.md' })).toThrow(
        /mutually exclusive/,
      );
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
        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-missing',
              resolves: [{ ref: 'no-such-stem#n1', outcome: 'done' }],
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/no-such-stem#n1 \(missing\)/);

        // Write-and-report: the narrative survives the bad ref.
        const written = path.join(
          activeRoot,
          SLUG,
          'sessions',
          '2026-05-12-0900-sess-missing.md',
        );
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

        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-parallel',
              resolves: [{ ref: tiedRef, outcome: 'done' }],
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/\(not-prior\)/);
      });
    });

    it('reports a session trying to close its own loop', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-self',
              next_steps: [{ id: 'n1', text: 'mine', kind: 'prose' }],
              resolves: [
                { ref: '2026-05-12-0900-sess-self#n1', outcome: 'done' },
              ],
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/2026-05-12-0900-sess-self#n1 \(self\)/);
      });
    });

    it('counts only the refs that closed a loop when some are bad', async () => {
      await withTempActiveRoot(async (activeRoot) => {
        const priorRef = await seedPriorLoop(activeRoot);
        await expect(
          wrap.run(
            baseArgs({
              session_id: 'sess-mixed',
              resolves: [
                { ref: priorRef, outcome: 'done' },
                { ref: 'typo#p1', outcome: 'done' },
              ],
            }),
            makeCtx(activeRoot),
          ),
        ).rejects.toThrow(/1 of 2 --resolves entries closed no loop/);
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

  it('serializes concurrent wraps on the initiative lock', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const results = await Promise.all([
        wrap.run(
          baseArgs({ session_id: 'race', no_loops: true }),
          makeCtx(activeRoot),
        ),
        wrap.run(
          baseArgs({ session_id: 'race', no_loops: true }),
          makeCtx(activeRoot),
        ),
      ]);

      const filenames = results.map((r) => r.filename).sort();
      expect(filenames).toEqual([
        '2026-05-12-0900-race-1.md',
        '2026-05-12-0900-race.md',
      ]);
    });
  });
});
