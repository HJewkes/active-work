import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import { getActiveRoot, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
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
});

const DEFAULT_LABEL = 'main';

export default defineCommand({
  name: 'worktree.set',
  description:
    'Add or update a worktree entry on an existing initiative. A lone worktree is made default automatically; use --default to promote an added one.',
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
    const briefPath = path.join(getActiveRoot(), args.slug, 'brief.md');
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

      const existing = frontmatter.worktrees ?? {};
      // Default when: explicitly requested, this is the only worktree, or we're
      // updating a label that was already the default (don't silently demote it).
      const hadOthers = Object.keys(existing).some((name) => name !== label);
      const wasDefault = existing[label]?.default === true;
      const makeDefault = args.default === true || !hadOthers || wasDefault;

      const nextWorktrees: NonNullable<BriefFrontmatter['worktrees']> = {};
      for (const [name, entry] of Object.entries(existing)) {
        const rest = { ...entry };
        delete rest.default;
        // A new default clears the flag on every other label.
        if (makeDefault && name !== label) {
          nextWorktrees[name] = rest;
        } else {
          nextWorktrees[name] = entry;
        }
      }
      nextWorktrees[label] = {
        path: args.path,
        ...(makeDefault ? { default: true } : {}),
      };

      const next = {
        ...frontmatter,
        worktrees: nextWorktrees,
        updated: today(),
      };
      await writeFrontmatter(briefPath, next, body, BriefFrontmatterSchema);
      return { slug: args.slug, label, path: args.path, default: makeDefault };
    });
  },
});
