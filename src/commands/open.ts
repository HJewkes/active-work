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
import { archiveStaleTasks } from '../bootstrap/archive-tasks.js';

/** Done tasks older than this are auto-archived on bootstrap (AW-8). */
const ARCHIVE_DONE_AFTER_DAYS = 30;

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  offline: z.boolean().optional(),
  // Directory used to auto-resolve an initiative when no slug is given.
  // Defaults to the process cwd; callers that do not share the user's shell
  // cwd (the daemon / MCP server) must pass this explicitly.
  cwd: z.string().min(1).optional(),
  // Force the picker even when the cwd matches an initiative's worktree.
  pick: z.boolean().optional(),
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
  // How the initiative was selected: an explicit/prefix slug, or a match
  // between the caller's cwd and one of the initiative's worktrees.
  resolved_from: z.enum(['slug', 'cwd']).optional(),
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

/** True when `child` is `parent` itself or nested beneath it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve an initiative slug from a working directory by matching it against
 * every initiative's worktree paths. When `cwd` sits inside more than one
 * worktree (e.g. nested checkouts) the deepest — longest — worktree path
 * wins. Returns null when nothing matches or two initiatives tie at the same
 * depth (ambiguous → let the caller fall back to the picker).
 */
async function resolveSlugFromCwd(
  activeRoot: string,
  cwd: string,
): Promise<string | null> {
  const resolvedCwd = path.resolve(cwd);
  const slugs = await listInitiativeSlugs(activeRoot);
  let best: { slug: string; depth: number } | null = null;
  let tiedAtBest = false;

  for (const slug of slugs) {
    const briefPath = path.join(activeRoot, slug, 'brief.md');
    let brief: BriefFrontmatter;
    try {
      ({ frontmatter: brief } = await readMarkdownWithSchema(
        briefPath,
        BriefFrontmatterSchema,
      ));
    } catch {
      continue;
    }
    for (const entry of Object.values(brief.worktrees ?? {})) {
      const worktreePath = path.resolve(expandTilde(entry.path));
      if (!isInside(resolvedCwd, worktreePath)) continue;
      const depth = worktreePath.length;
      if (best === null || depth > best.depth) {
        best = { slug, depth };
        tiedAtBest = false;
      } else if (depth === best.depth && slug !== best.slug) {
        tiedAtBest = true;
      }
    }
  }

  if (best === null || tiedAtBest) return null;
  return best.slug;
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

async function bootstrapInitiative(
  activeRoot: string,
  slug: string,
  offline: boolean | undefined,
  resolvedFrom: 'slug' | 'cwd',
): Promise<OpenResult & { metadata: BootstrapMetadata }> {
  const briefPath = path.join(activeRoot, slug, 'brief.md');
  const { frontmatter: brief } = await readMarkdownWithSchema(
    briefPath,
    BriefFrontmatterSchema,
  );
  const cwdHint = resolveCwdHint(activeRoot, slug, brief);
  const archivedTaskIds = await archiveStaleTasks(
    path.join(activeRoot, slug),
    { retentionDays: ARCHIVE_DONE_AFTER_DAYS, now: new Date() },
  );
  const { prompt, metadata } = await assembleBootstrap({
    activeRoot,
    slug,
    includeLiveStatus: !offline,
    archivedTaskIds,
  });
  return {
    slug,
    prompt,
    cwd_hint: cwdHint,
    ...(brief.channels && brief.channels.length > 0
      ? { channels: brief.channels }
      : {}),
    metadata,
    resolved_from: resolvedFrom,
  };
}

const openCommand = defineCommand<OpenArgs, OpenResult>({
  name: 'open',
  description:
    "Bootstrap a Claude session for an initiative. Without a slug, resolves the initiative whose worktree contains the caller's cwd; falls back to the picker list when nothing matches.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      offline: {
        long: '--offline',
        description: 'Skip the live `gh`/`git` artifact lookup; render artifacts statically.',
      },
      cwd: {
        long: '--cwd',
        description:
          'Directory to resolve the initiative from when no slug is given (default: current directory).',
      },
      pick: {
        long: '--pick',
        description:
          'Always return the picker list; skip resolving the initiative from the current directory.',
      },
    },
    usage: 'active-work open [slug] [--offline] [--cwd <dir>] [--pick]',
  },
  async run(args, ctx) {
    const activeRoot = ctx.activeRoot ?? getActiveRoot();

    if (args.slug) {
      const slug = await resolveSlug(activeRoot, args.slug);
      return bootstrapInitiative(activeRoot, slug, args.offline, 'slug');
    }

    // No slug: infer the initiative from the caller's working directory,
    // unless the caller explicitly asked for the picker.
    if (!args.pick) {
      const cwd = args.cwd ?? process.cwd();
      const matched = await resolveSlugFromCwd(activeRoot, cwd);
      if (matched) {
        return bootstrapInitiative(activeRoot, matched, args.offline, 'cwd');
      }
    }

    const initiatives = await collectInitiatives(activeRoot);
    return { picker: true, initiatives };
  },
});

export default openCommand;
