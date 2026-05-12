import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getInitiativeDir } from '../utils/paths.js';
import { today } from '../utils/today.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  file: z.string().min(1),
  type: z.enum(['pr', 'deepdive', 'session', 'pointer']),
  label: z.string().optional(),
  topic: z.string().optional(),
  pr_number: z.number().int().positive().optional(),
  date: z.string().optional(),
  force: z.boolean().optional(),
});

const ResultSchema = z.object({
  moved_to: z.string(),
  noop: z.boolean().optional(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

/**
 * Slugify a label or topic for use in a filename.
 *
 * Lowercases, replaces non-alphanumeric runs with `-`, trims leading/trailing
 * dashes. Falls back to `untitled` when the result is empty.
 */
export function slugifyLabel(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'untitled';
}

function deriveFilename(args: Args): string {
  switch (args.type) {
    case 'pr': {
      if (args.pr_number === undefined) {
        throw new ValidationError('source.add type=pr requires --pr-number');
      }
      if (!args.label) {
        throw new ValidationError('source.add type=pr requires --label');
      }
      return `pr-${args.pr_number}-${slugifyLabel(args.label)}.md`;
    }
    case 'deepdive': {
      if (!args.topic) {
        throw new ValidationError('source.add type=deepdive requires --topic');
      }
      return `deepdive-${slugifyLabel(args.topic)}.md`;
    }
    case 'session': {
      if (!args.label) {
        throw new ValidationError('source.add type=session requires --label');
      }
      const date = args.date ?? today();
      return `${date}-${slugifyLabel(args.label)}.md`;
    }
    case 'pointer': {
      if (!args.label) {
        throw new ValidationError('source.add type=pointer requires --label');
      }
      return `${slugifyLabel(args.label)}.md`;
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function movePath(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
      return;
    }
    throw err;
  }
}

export default defineCommand<Args, Result>({
  name: 'source.add',
  description:
    'Move a source file into <slug>/sources/ with a conventional filename.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'file'],
    options: {
      type: {
        long: '--type',
        description: 'Source type: pr | deepdive | session | pointer',
        required: true,
      },
      label: { long: '--label', description: 'Short label (slugified into filename)' },
      topic: { long: '--topic', description: 'Topic for deepdive type' },
      pr_number: { long: '--pr-number', description: 'PR number for type=pr' },
      date: { long: '--date', description: 'Date YYYY-MM-DD for type=session' },
      force: { long: '--force', description: 'Overwrite if target exists' },
    },
  },
  async run(args) {
    const sourcePath = path.resolve(args.file);
    if (!(await pathExists(sourcePath))) {
      throw new NotFoundError(`source file not found: ${sourcePath}`);
    }

    const filename = deriveFilename(args);
    const sourcesDir = path.join(getInitiativeDir(args.slug), 'sources');
    const targetPath = path.join(sourcesDir, filename);

    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
      return { moved_to: targetPath, noop: true };
    }

    await fs.mkdir(sourcesDir, { recursive: true });

    if ((await pathExists(targetPath)) && !args.force) {
      throw new ValidationError(
        `target already exists: ${targetPath} (use --force to overwrite)`,
      );
    }

    await movePath(sourcePath, targetPath);
    return { moved_to: targetPath };
  },
});
