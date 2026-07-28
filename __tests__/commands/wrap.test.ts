import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import wrap from '../../src/commands/wrap.js';
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

async function readFrontmatter(file: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(file, 'utf8');
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  return YAML.parse(block?.[1] ?? '') as Record<string, unknown>;
}

describe('wrap', () => {
  it('writes the session ledger and bumps brief.updated in one call', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await wrap.run(
        baseArgs({
          next_steps: NEXT_STEPS,
          resolves: [{ ref: '2026-05-10-1430-fixture001#n1', outcome: 'done' }],
        }),
        makeCtx(activeRoot),
      );

      expect(result.filename).toBe('2026-05-12-0900-sess-wrap.md');
      expect(result.next_steps).toBe(2);
      expect(result.resolves).toBe(1);
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
      const result = await wrap.run(
        baseArgs({
          session_id: 'sess-json',
          next_steps: JSON.stringify(NEXT_STEPS),
          resolves: JSON.stringify([
            { ref: 'aaa#n1', outcome: 'abandoned', note: 'superseded' },
          ]),
        }),
        makeCtx(activeRoot),
      );

      const frontmatter = await readFrontmatter(result.path);
      expect(frontmatter.next_steps).toEqual(NEXT_STEPS);
      expect(frontmatter.resolves).toEqual([
        { ref: 'aaa#n1', outcome: 'abandoned', note: 'superseded' },
      ]);
    });
  });

  it('refuses to wrap with an empty ledger, naming both ways forward', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const sessionsDir = path.join(activeRoot, SLUG, 'sessions');
      const before = await fs.readdir(sessionsDir);

      await expect(wrap.run(baseArgs(), makeCtx(activeRoot))).rejects.toThrow(
        /--next-steps.*--resolves.*--no-loops/s,
      );
      expect(await fs.readdir(sessionsDir)).toEqual(before);
    });
  });

  it('allows an empty ledger under --no-loops', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await wrap.run(
        baseArgs({ no_loops: true }),
        makeCtx(activeRoot),
      );
      const frontmatter = await readFrontmatter(result.path);
      expect(frontmatter.next_steps).toEqual([]);
      expect(frontmatter.resolves).toEqual([]);
      expect(result.updated).toBe(today());
    });
  });

  it('accepts a resolves-only ledger', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await wrap.run(
        baseArgs({
          session_id: 'sess-resolves-only',
          resolves: [{ ref: '2026-05-10-1430-fixture001#n1', outcome: 'done' }],
        }),
        makeCtx(activeRoot),
      );
      expect(result.next_steps).toBe(0);
      expect(result.resolves).toBe(1);
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
