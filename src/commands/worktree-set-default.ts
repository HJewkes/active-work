import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { getActiveRoot, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const DATE_FIELDS = new Set(['updated', 'paused_since']);

function normalizeDateFields(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const key of DATE_FIELDS) {
    const value = out[key];
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      out[key] = value.toISOString().slice(0, 10);
    }
  }
  return out;
}

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
      const { frontmatter: raw, body } = await readRawFrontmatter(briefPath);
      const normalized = normalizeDateFields(raw);
      const parsed = BriefFrontmatterSchema.safeParse(normalized);
      if (!parsed.success) {
        throw new ValidationError(
          `Frontmatter validation failed for ${briefPath}: ${parsed.error.message}`,
        );
      }
      const frontmatter = parsed.data;
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
