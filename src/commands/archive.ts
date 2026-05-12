import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NotFoundError, UsageError, ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  domain: z.string().min(1),
});

const ResultSchema = z.object({
  from: z.string(),
  to: z.string(),
});

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function yearMonth(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export default defineCommand({
  name: 'archive',
  description: 'Move an initiative out of active root into <archiveRoot>/<domain>/archive/.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'domain'],
    usage: 'aw archive <slug> <domain>',
  },
  async run(args, ctx) {
    const from = path.resolve(path.join(ctx.activeRoot, args.slug));
    if (!(await dirExists(from))) {
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }

    const cwd = path.resolve(process.cwd());
    if (isInside(cwd, from)) {
      throw new UsageError(
        `Refusing to archive: current working directory is inside ${from}. cd elsewhere first.`,
      );
    }

    const archiveRoot = path.resolve(ctx.activeRoot, '..');
    const destDir = path.join(archiveRoot, args.domain, 'archive');
    const to = path.join(destDir, `${args.slug}-${yearMonth()}`);

    if (await dirExists(to)) {
      throw new ValidationError(`Archive destination already exists: ${to}`);
    }

    await fs.mkdir(destDir, { recursive: true });

    try {
      await fs.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        await fs.cp(from, to, { recursive: true });
        await fs.rm(from, { recursive: true, force: true });
      } else {
        throw err;
      }
    }

    return { from, to };
  },
});
