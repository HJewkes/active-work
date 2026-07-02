import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import { getActiveRoot, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const argsSchema = z.object({
  slug: z.string().min(1),
  label: z.string().min(1),
});

const resultSchema = z.object({
  slug: z.string(),
  default_label: z.string(),
});

export default defineCommand({
  name: 'worktree.set-default',
  description:
    'Mark the named worktree label as default for an initiative; clears default on other labels.',
  args: argsSchema,
  result: resultSchema,
  cli: {
    positional: ['slug', 'label'],
  },
  async run({ slug, label }) {
    const briefPath = path.join(getActiveRoot(), slug, 'brief.md');
    return withFileLock(getLockPath(slug), async () => {
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
      const worktrees = frontmatter.worktrees;
      if (!worktrees || !Object.prototype.hasOwnProperty.call(worktrees, label)) {
        throw new NotFoundError(
          `Worktree label "${label}" not found in brief for "${slug}"`,
        );
      }
      const nextWorktrees: NonNullable<typeof worktrees> = {};
      for (const [name, entry] of Object.entries(worktrees)) {
        const rest = { ...entry };
        delete rest.default;
        if (name === label) {
          nextWorktrees[name] = { ...rest, default: true };
        } else {
          nextWorktrees[name] = rest;
        }
      }
      const next = {
        ...frontmatter,
        worktrees: nextWorktrees,
        updated: today(),
      };
      await writeFrontmatter(briefPath, next, body, BriefFrontmatterSchema);
      return { slug, default_label: label };
    });
  },
});
