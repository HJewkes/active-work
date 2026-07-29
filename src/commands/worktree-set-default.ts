import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import { getActiveRoot, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import {
  readArtifactsFile,
  writeArtifactsFile,
} from '../utils/registered-worktrees.js';
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
    const initiativeDir = path.join(getActiveRoot(), slug);
    const briefPath = path.join(initiativeDir, 'brief.md');
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
      const artifacts = await readArtifactsFile(initiativeDir);
      if (!artifacts.worktrees.some((entry) => entry.name === label)) {
        throw new NotFoundError(
          `Worktree label "${label}" is not registered for "${slug}"`,
        );
      }
      const worktrees = artifacts.worktrees.map((entry) => {
        const next = { ...entry };
        delete next.default;
        return entry.name === label ? { ...next, default: true } : next;
      });
      await writeArtifactsFile(initiativeDir, { ...artifacts, worktrees });
      await writeFrontmatter(
        briefPath,
        { ...frontmatter, updated: today() },
        body,
        BriefFrontmatterSchema,
      );
      return { slug, default_label: label };
    });
  },
});
