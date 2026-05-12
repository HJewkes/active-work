import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { getInitiativeDir } from '../utils/paths.js';
import { atomicWrite } from '../utils/fs-atomic.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import { derivePrefix, validateSlug } from '../utils/slug.js';
import { today } from '../utils/today.js';
import { UsageError, ValidationError } from '../errors.js';
import { stringify as yamlStringify } from 'yaml';
import { appendTriagedLog } from '../discover/triaged-log.js';

/**
 * `aw track <ref> --slug <slug>` — scaffold a fresh initiative from a
 * discover hit. The original `ref` is preserved in the brief body so
 * future readers can trace where the initiative came from.
 *
 * This deliberately re-implements directory scaffolding inline rather
 * than importing `aw new`; the parallel-work split means `new` lives on a
 * branch this one can't reach.
 */

const ArgsSchema = z.object({
  ref: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().optional(),
  ship_target: z.string().optional(),
  owner: z.string().optional(),
  worktree: z.string().optional(),
});

const ResultSchema = z.object({
  slug: z.string(),
  dir: z.string(),
  ref: z.string(),
});

export default defineCommand({
  name: 'track',
  description: 'Scaffold a new initiative from a discover hit.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['ref'],
    options: {
      slug: {
        long: '--slug',
        description: 'Kebab-case slug for the new initiative',
        required: true,
      },
      title: { long: '--title', description: 'Human-readable initiative title' },
      ship_target: { long: '--ship-target', description: 'Target ship window (e.g. 2026-Q3)' },
      owner: { long: '--owner', description: 'Initiative owner handle' },
      worktree: {
        long: '--worktree',
        description: 'Default worktree path to record on the brief',
      },
    },
  },
  async run(args) {
    const validation = validateSlug(args.slug);
    if (!validation.ok) {
      throw new ValidationError(validation.error);
    }
    const dir = getInitiativeDir(args.slug);

    if (await dirExists(dir)) {
      throw new UsageError(`Initiative already exists: ${args.slug}`);
    }
    await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(dir, 'sources'), { recursive: true });

    const title = args.title ?? deriveTitle(args.slug);
    const briefBody = buildBriefBody(title, args.ref);

    const worktrees = args.worktree
      ? { main: { path: args.worktree, default: true } }
      : undefined;

    await writeFrontmatter(
      path.join(dir, 'brief.md'),
      {
        schema_version: 1,
        title,
        updated: today(),
        state: 'backburner' as const,
        ...(args.ship_target ? { ship_target: args.ship_target } : {}),
        ...(args.owner ? { owner: args.owner } : {}),
        task_prefix: derivePrefix(args.slug),
        ...(worktrees ? { worktrees } : {}),
      },
      briefBody,
      BriefFrontmatterSchema,
    );

    await atomicWrite(
      path.join(dir, 'handoff.md'),
      buildHandoff(title, args.ref),
    );

    const artifacts = ArtifactsSchema.parse({});
    await atomicWrite(path.join(dir, 'artifacts.yml'), yamlStringify(artifacts));
    await atomicWrite(path.join(dir, 'sources', '.gitkeep'), '');

    await appendTriagedLog('track', args.ref, `slug:${args.slug}`);

    return { slug: args.slug, dir, ref: args.ref };
  },
});

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function deriveTitle(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(' ');
}

function buildBriefBody(title: string, ref: string): string {
  return [
    `# ${title}`,
    '',
    `Source: ${ref}`,
    '',
    'This initiative was scaffolded from a discover hit. Replace this',
    'placeholder body with the actual brief before promoting from',
    'backburner to focused.',
    '',
  ].join('\n');
}

function buildHandoff(title: string, ref: string): string {
  return [
    '# Current state',
    '',
    `New initiative \`${title}\` tracked from discover hit \`${ref}\`.`,
    'No work landed yet — fill this in after the first working session.',
    '',
  ].join('\n');
}
