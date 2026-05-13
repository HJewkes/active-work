import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import { writeYaml } from '../utils/yaml-io.js';
import { today } from '../utils/today.js';
import { validateSlug, derivePrefix } from '../utils/slug.js';
import { ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  ship_target: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
});

const ResultSchema = z.object({
  slug: z.string(),
  dir: z.string(),
  rank: z.number().int().positive(),
  task_prefix: z.string(),
});

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function computeNextRank(activeRoot: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(activeRoot);
  } catch {
    return 1;
  }
  let max = 0;
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const briefPath = path.join(activeRoot, entry, 'brief.md');
    let raw: string;
    try {
      raw = await fs.readFile(briefPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    if (data.state === 'focused' && typeof data.rank === 'number' && data.rank > max) {
      max = data.rank;
    }
  }
  return max + 1;
}

export default defineCommand({
  name: 'new',
  description: 'Scaffold a new initiative directory.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      title: { long: '--title', description: 'Initiative title', required: true },
      ship_target: { long: '--ship-target', description: 'Ship target (e.g., 2026-Q3)' },
      owner: { long: '--owner', description: 'Owner / handle' },
      worktree: { long: '--worktree', description: 'Default worktree path' },
    },
    usage: 'active-work new <slug> --title <title> [--ship-target <t>] [--owner <o>] [--worktree <path>]',
  },
  async run(args, ctx) {
    const slugCheck = validateSlug(args.slug);
    if (!slugCheck.ok) {
      throw new ValidationError(`Invalid slug "${args.slug}": ${slugCheck.error}`);
    }

    const dir = path.join(ctx.activeRoot, args.slug);
    if (await dirExists(dir)) {
      throw new ValidationError(`Initiative already exists: ${args.slug} (${dir})`);
    }

    const rank = await computeNextRank(ctx.activeRoot);
    const task_prefix = derivePrefix(args.slug);

    const frontmatter: BriefFrontmatter = {
      schema_version: 1,
      title: args.title,
      updated: today(),
      state: 'focused',
      rank,
      task_prefix,
      ...(args.ship_target ? { ship_target: args.ship_target } : {}),
      ...(args.owner ? { owner: args.owner } : {}),
      ...(args.worktree
        ? { worktrees: { main: { path: args.worktree, default: true } } }
        : {}),
    };

    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(dir, 'sources'), { recursive: true });

    const briefBody = `# ${args.title}\n\nWhy: ...\n`;
    await writeFrontmatter(
      path.join(dir, 'brief.md'),
      frontmatter,
      briefBody,
      BriefFrontmatterSchema,
    );

    const handoffBody = `# Current state\n\n_(write a paragraph here)_\n`;
    await fs.writeFile(path.join(dir, 'handoff.md'), handoffBody, 'utf8');

    await writeYaml(
      path.join(dir, 'artifacts.yml'),
      { prs: [], branches: [], stashes: [] },
      ArtifactsSchema,
    );

    return {
      slug: args.slug,
      dir,
      rank,
      task_prefix,
    };
  },
});
