import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import worktreeSetDefault from '../../src/commands/worktree-set-default.js';
import audit from '../../src/commands/audit.js';
import list from '../../src/commands/list.js';
import {
  withEmptyActiveRoot,
  withTempActiveRoot,
} from '../setup/test-helpers.js';
import type {
  Command,
  CommandContext,
} from '../../src/registry/types.js';
import { BriefFrontmatterSchema } from '../../src/schemas/brief.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

async function run<A, R>(
  cmd: Command<A, R>,
  args: A,
  ctx: CommandContext,
): Promise<R> {
  const parsed = cmd.args.parse(args);
  return cmd.run(parsed, ctx);
}

interface BriefInput {
  title: string;
  state: 'focused' | 'backburner' | 'paused' | 'done';
  rank?: number;
  paused_since?: string;
  restart_trigger?: string;
  ship_target?: string;
  task_prefix: string;
  updated?: string;
  worktrees?: Record<string, { path: string; default?: boolean }>;
}

async function scaffoldInitiative(
  activeRoot: string,
  slug: string,
  input: BriefInput,
  body = `# ${input.title}\n`,
): Promise<string> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  const frontmatter = {
    schema_version: 1,
    title: input.title,
    updated: input.updated ?? '2026-05-12',
    state: input.state,
    ...(input.rank !== undefined ? { rank: input.rank } : {}),
    ...(input.paused_since ? { paused_since: input.paused_since } : {}),
    ...(input.restart_trigger ? { restart_trigger: input.restart_trigger } : {}),
    ...(input.ship_target ? { ship_target: input.ship_target } : {}),
    task_prefix: input.task_prefix,
    ...(input.worktrees ? { worktrees: input.worktrees } : {}),
  };
  // Validate via schema so test inputs stay consistent with production.
  BriefFrontmatterSchema.parse(frontmatter);
  const briefPath = path.join(dir, 'brief.md');
  await fs.writeFile(briefPath, matter.stringify(body, frontmatter));
  return briefPath;
}

describe('worktree.set-default', () => {
  it('flips default to the named label and clears it on the others', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffoldInitiative(activeRoot, 'two-worktrees', {
        title: 'Two Worktrees',
        state: 'focused',
        rank: 1,
        task_prefix: 'TW',
        worktrees: {
          main: { path: '~/code/two-worktrees/main', default: true },
          spike: { path: '~/code/two-worktrees/spike' },
        },
      });

      const result = await run(
        worktreeSetDefault,
        { slug: 'two-worktrees', label: 'spike' },
        makeCtx(activeRoot),
      );
      expect(result).toEqual({
        slug: 'two-worktrees',
        default_label: 'spike',
      });

      const raw = await fs.readFile(
        path.join(activeRoot, 'two-worktrees', 'brief.md'),
        'utf8',
      );
      const parsed = matter(raw);
      const fm = parsed.data as {
        worktrees: Record<string, { path: string; default?: boolean }>;
      };
      expect(fm.worktrees.spike.default).toBe(true);
      expect(fm.worktrees.main.default).toBeUndefined();
    });
  });

  it('throws NotFoundError when the label is missing', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        run(
          worktreeSetDefault,
          { slug: 'sample-initiative', label: 'does-not-exist' },
          makeCtx(activeRoot),
        ),
      ).rejects.toThrow(/Worktree label "does-not-exist"/);
    });
  });
});

describe('audit', () => {
  it('returns the sample initiative', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await run(audit, {}, makeCtx(activeRoot));
      expect(result.parse_errors).toEqual([]);
      expect(result.worktree_conflicts).toEqual([]);
      expect(result.initiatives).toHaveLength(1);
      expect(result.initiatives[0]).toMatchObject({
        slug: 'sample-initiative',
        state: 'focused',
        rank: 1,
      });
    });
  });

  it('detects worktree path conflicts across initiatives', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffoldInitiative(activeRoot, 'alpha', {
        title: 'Alpha',
        state: 'focused',
        rank: 1,
        task_prefix: 'AL',
        worktrees: {
          main: { path: '~/code/shared-worktree', default: true },
        },
      });
      await scaffoldInitiative(activeRoot, 'beta', {
        title: 'Beta',
        state: 'focused',
        rank: 2,
        task_prefix: 'BE',
        worktrees: {
          main: { path: '~/code/shared-worktree', default: true },
        },
      });

      const result = await run(audit, {}, makeCtx(activeRoot));
      expect(result.worktree_conflicts).toHaveLength(1);
      expect(result.worktree_conflicts[0].slugs).toEqual(['alpha', 'beta']);
      expect(result.worktree_conflicts[0].path).toMatch(/shared-worktree$/);
    });
  });

  it('collects parse errors without throwing', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffoldInitiative(activeRoot, 'ok', {
        title: 'OK',
        state: 'backburner',
        task_prefix: 'OK',
      });
      // Write an invalid brief directly (missing required fields).
      const badDir = path.join(activeRoot, 'broken');
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(
        path.join(badDir, 'brief.md'),
        '---\nschema_version: 1\ntitle: Broken\n---\n# Broken\n',
      );

      const result = await run(audit, {}, makeCtx(activeRoot));
      expect(result.initiatives.map((i) => i.slug)).toEqual(['ok']);
      expect(result.parse_errors).toHaveLength(1);
      expect(result.parse_errors[0].slug).toBe('broken');
    });
  });

  it('sorts focused initiatives by rank', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffoldInitiative(activeRoot, 'second', {
        title: 'Second',
        state: 'focused',
        rank: 2,
        task_prefix: 'SE',
      });
      await scaffoldInitiative(activeRoot, 'first', {
        title: 'First',
        state: 'focused',
        rank: 1,
        task_prefix: 'FI',
      });

      const result = await run(audit, {}, makeCtx(activeRoot));
      expect(result.initiatives.map((i) => i.slug)).toEqual([
        'first',
        'second',
      ]);
    });
  });
});

describe('list', () => {
  it('groups initiatives into state-keyed sections', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffoldInitiative(activeRoot, 'focus-b', {
        title: 'Focus B',
        state: 'focused',
        rank: 2,
        task_prefix: 'FB',
      });
      await scaffoldInitiative(activeRoot, 'focus-a', {
        title: 'Focus A',
        state: 'focused',
        rank: 1,
        task_prefix: 'FA',
      });
      await scaffoldInitiative(activeRoot, 'back-y', {
        title: 'Back Y',
        state: 'backburner',
        task_prefix: 'BY',
      });
      await scaffoldInitiative(activeRoot, 'paused-one', {
        title: 'Paused One',
        state: 'paused',
        paused_since: '2026-03-01',
        restart_trigger: 'when blocker clears',
        task_prefix: 'PO',
      });
      await scaffoldInitiative(activeRoot, 'paused-two', {
        title: 'Paused Two',
        state: 'paused',
        paused_since: '2026-01-15',
        restart_trigger: 'review next quarter',
        task_prefix: 'PT',
      });
      await scaffoldInitiative(activeRoot, 'shipped', {
        title: 'Shipped',
        state: 'done',
        task_prefix: 'SH',
        updated: '2026-04-15',
      });
      await scaffoldInitiative(activeRoot, 'older-shipped', {
        title: 'Older Shipped',
        state: 'done',
        task_prefix: 'OS',
        updated: '2026-02-01',
      });

      const result = await run(list, {}, makeCtx(activeRoot));
      const sections = Object.fromEntries(
        result.sections.map((s) => [s.heading, s.items.map((i) => i.slug)]),
      );
      expect(sections.Focused).toEqual(['focus-a', 'focus-b']);
      expect(sections.Backburner).toEqual(['back-y']);
      expect(sections.Paused).toEqual(['paused-two', 'paused-one']);
      expect(sections.Done).toEqual(['shipped', 'older-shipped']);
    });
  });

  it('exposes parse errors alongside sections', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const badDir = path.join(activeRoot, 'broken');
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(
        path.join(badDir, 'brief.md'),
        '---\nnot: valid\n---\n',
      );
      const result = await run(list, {}, makeCtx(activeRoot));
      expect(result.parse_errors).toHaveLength(1);
      expect(result.parse_errors[0].slug).toBe('broken');
      expect(result.sections.map((s) => s.heading)).toEqual([
        'Focused',
        'Backburner',
        'Paused',
        'Done',
      ]);
    });
  });
});
