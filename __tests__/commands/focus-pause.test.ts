import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import focusCmd from '../../src/commands/focus.js';
import unfocusCmd from '../../src/commands/unfocus.js';
import pauseCmd from '../../src/commands/pause.js';
import unpauseCmd from '../../src/commands/unpause.js';
import {
  BriefFrontmatterSchema,
  type BriefFrontmatter,
} from '../../src/schemas/brief.js';
import { readRawFrontmatter } from '../../src/utils/gray-matter-io.js';
import type { CommandContext } from '../../src/registry/types.js';
import { UsageError, NotFoundError } from '../../src/errors.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

interface SeedOptions {
  state?: BriefFrontmatter['state'];
  rank?: number;
  paused_since?: string;
  restart_trigger?: string;
}

async function seedInitiative(
  activeRoot: string,
  slug: string,
  opts: SeedOptions = {},
): Promise<void> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  const state = opts.state ?? 'backburner';
  const front: Record<string, unknown> = {
    schema_version: 1,
    title: slug,
    updated: '2026-05-10',
    state,
    task_prefix: slug.slice(0, 2).toUpperCase().padEnd(2, 'X'),
  };
  if (state === 'focused') front.rank = opts.rank ?? 1;
  if (state === 'paused') {
    front.paused_since = opts.paused_since ?? '2026-05-01';
    front.restart_trigger = opts.restart_trigger ?? 'manual';
  }
  // Validate before writing so a malformed seed fails loudly.
  BriefFrontmatterSchema.parse(front);
  const yaml = Object.entries(front)
    .map(([k, v]) =>
      typeof v === 'string' ? `${k}: ${v}` : `${k}: ${String(v)}`,
    )
    .join('\n');
  await fs.writeFile(
    path.join(dir, 'brief.md'),
    `---\n${yaml}\n---\n\n# ${slug}\n`,
    'utf8',
  );
}

async function readBrief(
  activeRoot: string,
  slug: string,
): Promise<BriefFrontmatter> {
  const briefPath = path.join(activeRoot, slug, 'brief.md');
  const { frontmatter } = await readRawFrontmatter(briefPath);
  const normalized: Record<string, unknown> = { ...frontmatter };
  for (const field of ['updated', 'paused_since']) {
    const value = normalized[field];
    if (value instanceof Date) {
      normalized[field] = value.toISOString().slice(0, 10);
    }
  }
  return BriefFrontmatterSchema.parse(normalized);
}

describe('focus command', () => {
  it('appends to end of focused list when --rank is omitted', async () => {
    await withTempActiveRoot(async (root) => {
      await seedInitiative(root, 'alpha', { state: 'backburner' });
      const result = await focusCmd.run({ slug: 'alpha' }, ctx(root));
      // sample-initiative already at 1, so alpha lands at 2
      expect(result.slug).toBe('alpha');
      expect(result.rank).toBe(2);
      expect(result.shifted).toEqual([]);

      const alpha = await readBrief(root, 'alpha');
      expect(alpha.state).toBe('focused');
      expect(alpha.rank).toBe(2);

      const sample = await readBrief(root, 'sample-initiative');
      expect(sample.rank).toBe(1);
    });
  });

  it('shifts existing focused initiatives down when inserting at a lower rank', async () => {
    await withTempActiveRoot(async (root) => {
      await seedInitiative(root, 'beta', { state: 'backburner' });
      // Now there is sample-initiative at rank 1. Focus beta at rank 1.
      const result = await focusCmd.run(
        { slug: 'beta', rank: 1 },
        ctx(root),
      );
      expect(result.rank).toBe(1);
      expect(result.shifted).toEqual([
        { slug: 'sample-initiative', from: 1, to: 2 },
      ]);

      expect((await readBrief(root, 'beta')).rank).toBe(1);
      expect((await readBrief(root, 'sample-initiative')).rank).toBe(2);
    });
  });

  it('re-ranks an already-focused initiative without leaving a duplicate', async () => {
    await withTempActiveRoot(async (root) => {
      // Seed: sample (rank 1, from fixture), gamma rank 2, delta rank 3
      await seedInitiative(root, 'gamma', { state: 'focused', rank: 2 });
      await seedInitiative(root, 'delta', { state: 'focused', rank: 3 });

      // Move delta to rank 1
      const result = await focusCmd.run(
        { slug: 'delta', rank: 1 },
        ctx(root),
      );
      expect(result.rank).toBe(1);

      const sample = await readBrief(root, 'sample-initiative');
      const gamma = await readBrief(root, 'gamma');
      const delta = await readBrief(root, 'delta');
      expect(delta.rank).toBe(1);
      expect(sample.rank).toBe(2);
      expect(gamma.rank).toBe(3);
    });
  });

  it('rejects rank beyond list length + 1', async () => {
    await withTempActiveRoot(async (root) => {
      await seedInitiative(root, 'epsilon', { state: 'backburner' });
      // Only sample is focused (1), so max insert position is 2.
      await expect(
        focusCmd.run({ slug: 'epsilon', rank: 99 }, ctx(root)),
      ).rejects.toBeInstanceOf(UsageError);
    });
  });

  it('throws NotFoundError when slug does not exist', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        focusCmd.run({ slug: 'no-such', rank: 1 }, ctx(root)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('unfocus command', () => {
  it('clears rank, sets state to backburner, renumbers survivors gapless', async () => {
    await withTempActiveRoot(async (root) => {
      // sample at 1; add focused initiatives at 2 and 3
      await seedInitiative(root, 'two', { state: 'focused', rank: 2 });
      await seedInitiative(root, 'three', { state: 'focused', rank: 3 });

      const result = await unfocusCmd.run(
        { slug: 'sample-initiative' },
        ctx(root),
      );
      expect(result.slug).toBe('sample-initiative');
      expect(result.renumbered).toEqual([
        { slug: 'two', from: 2, to: 1 },
        { slug: 'three', from: 3, to: 2 },
      ]);

      const sample = await readBrief(root, 'sample-initiative');
      expect(sample.state).toBe('backburner');
      expect(sample.rank).toBeUndefined();
      expect((await readBrief(root, 'two')).rank).toBe(1);
      expect((await readBrief(root, 'three')).rank).toBe(2);
    });
  });

  it('throws UsageError when initiative is not focused', async () => {
    await withTempActiveRoot(async (root) => {
      await seedInitiative(root, 'backed', { state: 'backburner' });
      await expect(
        unfocusCmd.run({ slug: 'backed' }, ctx(root)),
      ).rejects.toBeInstanceOf(UsageError);
    });
  });
});

describe('pause command', () => {
  it('persists since + restart_trigger and clears rank', async () => {
    await withTempActiveRoot(async (root) => {
      await seedInitiative(root, 'second', { state: 'focused', rank: 2 });

      const result = await pauseCmd.run(
        {
          slug: 'sample-initiative',
          since: '2026-05-12',
          restart_trigger: 'when Q3 planning starts',
        },
        ctx(root),
      );
      expect(result.paused_since).toBe('2026-05-12');
      expect(result.restart_trigger).toBe('when Q3 planning starts');

      const sample = await readBrief(root, 'sample-initiative');
      expect(sample.state).toBe('paused');
      expect(sample.rank).toBeUndefined();
      expect(sample.paused_since).toBe('2026-05-12');
      expect(sample.restart_trigger).toBe('when Q3 planning starts');

      // survivor renumbered to gapless 1
      expect((await readBrief(root, 'second')).rank).toBe(1);
    });
  });

  it('rejects when since or restart_trigger are missing', () => {
    const parsed = pauseCmd.args.safeParse({
      slug: 'sample-initiative',
      since: '2026-05-12',
    });
    expect(parsed.success).toBe(false);

    const parsed2 = pauseCmd.args.safeParse({
      slug: 'sample-initiative',
      restart_trigger: 'x',
    });
    expect(parsed2.success).toBe(false);
  });

  it('rejects an invalid since date', () => {
    const parsed = pauseCmd.args.safeParse({
      slug: 'sample-initiative',
      since: 'not-a-date',
      restart_trigger: 'x',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('unpause command', () => {
  it('clears paused fields and sets state to backburner', async () => {
    await withTempActiveRoot(async (root) => {
      await seedInitiative(root, 'restful', {
        state: 'paused',
        paused_since: '2026-05-01',
        restart_trigger: 'when ready',
      });
      const result = await unpauseCmd.run({ slug: 'restful' }, ctx(root));
      expect(result.slug).toBe('restful');

      const after = await readBrief(root, 'restful');
      expect(after.state).toBe('backburner');
      expect(after.paused_since).toBeUndefined();
      expect(after.restart_trigger).toBeUndefined();
      expect(after.rank).toBeUndefined();
    });
  });

  it('throws UsageError when initiative is not paused', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        unpauseCmd.run({ slug: 'sample-initiative' }, ctx(root)),
      ).rejects.toBeInstanceOf(UsageError);
    });
  });
});
