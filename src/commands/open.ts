import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BriefFrontmatterSchema,
  type BriefFrontmatter,
} from '../schemas/brief.js';
import { getActiveRoot, expandTilde } from '../utils/paths.js';
import { NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import {
  assembleBootstrap,
  readMarkdownWithSchema,
  type BootstrapMetadata,
} from '../bootstrap/prompt.js';

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
});

const InitiativeSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  state: z.enum(['focused', 'backburner', 'paused', 'done']),
  rank: z.number().int().positive().optional(),
});

const PickerResultSchema = z.object({
  picker: z.literal(true),
  initiatives: z.array(InitiativeSummarySchema),
});

const OpenResultSchema = z.object({
  slug: z.string(),
  prompt: z.string(),
  cwd_hint: z.string(),
  channels: z.array(z.string()).optional(),
  metadata: z.object({
    slug: z.string(),
    brief_title: z.string(),
    last_session: z
      .object({ filename: z.string(), ended: z.string() })
      .optional(),
    time_since_last_session_human: z.string().optional(),
    open_task_count: z.number().int().nonnegative(),
    recently_done_count: z.number().int().nonnegative(),
    bootstrap_at: z.string(),
  }),
});

const ResultSchema = z.union([OpenResultSchema, PickerResultSchema]);

type OpenArgs = z.infer<typeof ArgsSchema>;
type OpenResult = z.infer<typeof ResultSchema>;

interface InitiativeSummary {
  slug: string;
  title: string;
  state: BriefFrontmatter['state'];
  rank?: number;
}

const STATE_ORDER: Record<BriefFrontmatter['state'], number> = {
  focused: 0,
  backburner: 1,
  paused: 2,
  done: 3,
};

async function listInitiativeSlugs(activeRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

async function loadInitiativeSummary(
  activeRoot: string,
  slug: string,
): Promise<InitiativeSummary | null> {
  const briefPath = path.join(activeRoot, slug, 'brief.md');
  try {
    const { frontmatter } = await readMarkdownWithSchema(
      briefPath,
      BriefFrontmatterSchema,
    );
    return {
      slug,
      title: frontmatter.title,
      state: frontmatter.state,
      rank: frontmatter.rank,
    };
  } catch {
    return null;
  }
}

function compareInitiatives(a: InitiativeSummary, b: InitiativeSummary): number {
  const stateDiff = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (stateDiff !== 0) return stateDiff;
  if (a.rank !== undefined && b.rank !== undefined && a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  if (a.rank !== undefined && b.rank === undefined) return -1;
  if (a.rank === undefined && b.rank !== undefined) return 1;
  return a.slug.localeCompare(b.slug);
}

async function collectInitiatives(
  activeRoot: string,
): Promise<InitiativeSummary[]> {
  const slugs = await listInitiativeSlugs(activeRoot);
  const summaries: InitiativeSummary[] = [];
  for (const slug of slugs) {
    const summary = await loadInitiativeSummary(activeRoot, slug);
    if (summary) summaries.push(summary);
  }
  summaries.sort(compareInitiatives);
  return summaries;
}

async function resolveSlug(activeRoot: string, input: string): Promise<string> {
  const slugs = await listInitiativeSlugs(activeRoot);
  if (slugs.includes(input)) return input;
  const matches = slugs.filter((s) => s.startsWith(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new NotFoundError(
      `Ambiguous slug '${input}'. Candidates: ${matches.join(', ')}`,
    );
  }
  if (slugs.length === 0) {
    throw new NotFoundError(`No initiatives found under ${activeRoot}`);
  }
  throw new NotFoundError(
    `No initiative matches '${input}'. Known: ${slugs.join(', ')}`,
  );
}

function resolveCwdHint(
  activeRoot: string,
  slug: string,
  brief: BriefFrontmatter,
): string {
  const worktrees = brief.worktrees ?? {};
  for (const entry of Object.values(worktrees)) {
    if (entry.default) return expandTilde(entry.path);
  }
  const entries = Object.values(worktrees);
  if (entries.length === 1) return expandTilde(entries[0]!.path);
  return path.join(activeRoot, slug);
}

const openCommand = defineCommand<OpenArgs, OpenResult>({
  name: 'open',
  description:
    'Bootstrap a Claude session for an initiative. Without a slug, returns the picker list of known initiatives.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    usage: 'active-work open [slug]',
  },
  async run(args, ctx) {
    const activeRoot = ctx.activeRoot ?? getActiveRoot();

    if (!args.slug) {
      const initiatives = await collectInitiatives(activeRoot);
      return { picker: true, initiatives };
    }

    const slug = await resolveSlug(activeRoot, args.slug);
    const briefPath = path.join(activeRoot, slug, 'brief.md');
    const { frontmatter: brief } = await readMarkdownWithSchema(
      briefPath,
      BriefFrontmatterSchema,
    );
    const cwdHint = resolveCwdHint(activeRoot, slug, brief);
    const { prompt, metadata } = await assembleBootstrap({
      activeRoot,
      slug,
    });
    const result: OpenResult & { metadata: BootstrapMetadata } = {
      slug,
      prompt,
      cwd_hint: cwdHint,
      ...(brief.channels && brief.channels.length > 0
        ? { channels: brief.channels }
        : {}),
      metadata,
    };
    return result;
  },
});

export default openCommand;
