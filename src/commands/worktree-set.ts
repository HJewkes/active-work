import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import type { WorktreeEntry } from '../schemas/artifacts.js';
import { getActiveRoot, getLockPath, expandTilde } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import {
  readArtifactsFile,
  writeArtifactsFile,
} from '../utils/registered-worktrees.js';
import { readFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const argsSchema = z.object({
  slug: z.string().min(1),
  path: z.string().min(1),
  label: z.string().min(1).optional(),
  default: z.boolean().optional(),
});

const resultSchema = z.object({
  slug: z.string(),
  label: z.string(),
  path: z.string(),
  default: z.boolean(),
  /** True when this promoted a worktree `wrap` had already swept (AW-67). */
  promoted: z.boolean(),
});

const DEFAULT_LABEL = 'main';

const samePath = (a: string, b: string): boolean =>
  path.resolve(expandTilde(a)) === path.resolve(expandTilde(b));

export default defineCommand({
  name: 'worktree.set',
  description:
    'Add or update a registered worktree on an existing initiative. A lone worktree is made default automatically; use --default to promote an added one. Registered worktrees live in artifacts.yml alongside the ones wrap sweeps, and are what `aw` resolves a cwd against.',
  args: argsSchema,
  result: resultSchema,
  cli: {
    positional: ['slug', 'path'],
    options: {
      label: {
        long: '--label',
        description: `Worktree label (default: ${DEFAULT_LABEL}).`,
      },
      default: {
        long: '--default',
        description: 'Mark this worktree as the default, clearing default on others.',
      },
    },
    usage: 'active-work worktree.set <slug> <path> [--label <label>] [--default]',
  },
  async run(args) {
    const label = args.label ?? DEFAULT_LABEL;
    const initiativeDir = path.join(getActiveRoot(), args.slug);
    const briefPath = path.join(initiativeDir, 'brief.md');
    return withFileLock(getLockPath(args.slug), async () => {
      let frontmatter: BriefFrontmatter;
      let body: string;
      try {
        ({ frontmatter, body } = await readFrontmatter(
          briefPath,
          BriefFrontmatterSchema,
        ));
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }

      const artifacts = await readArtifactsFile(initiativeDir);
      const byLabel = artifacts.worktrees.find((entry) => entry.name === label);
      // An unnamed entry at this path was swept by `wrap`. Naming it promotes it
      // in place rather than adding a second record of the same directory.
      const swept = artifacts.worktrees.find(
        (entry) => entry.name === undefined && samePath(entry.path, args.path),
      );
      const target = byLabel ?? swept;

      // Default when: explicitly requested, this is the only registered
      // worktree, or we're updating a label that was already the default (don't
      // silently demote it).
      const named = artifacts.worktrees.filter((e) => e.name !== undefined);
      const hadOthers = named.some((entry) => entry.name !== label);
      const makeDefault =
        args.default === true || !hadOthers || byLabel?.default === true;

      const updated: WorktreeEntry = {
        ...(target ?? {}),
        path: args.path,
        repo: target?.repo ?? args.path,
        name: label,
        ...(makeDefault ? { default: true } : {}),
      };
      if (!makeDefault) delete updated.default;

      const rest = artifacts.worktrees
        .filter((entry) => entry !== target)
        .map((entry) => {
          if (!makeDefault || entry.default !== true) return entry;
          // A new default clears the flag everywhere else.
          const cleared = { ...entry };
          delete cleared.default;
          return cleared;
        });

      await writeArtifactsFile(initiativeDir, {
        ...artifacts,
        worktrees: [...rest, updated],
      });
      await writeFrontmatter(
        briefPath,
        { ...frontmatter, updated: today() },
        body,
        BriefFrontmatterSchema,
      );
      return {
        slug: args.slug,
        label,
        path: args.path,
        default: makeDefault,
        promoted: byLabel === undefined && swept !== undefined,
      };
    });
  },
});
