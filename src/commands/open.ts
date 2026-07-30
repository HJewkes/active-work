import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import { getActiveRoot, expandTilde } from '../utils/paths.js';
import { defaultWorktreePath, readRegisteredWorktrees } from '../utils/registered-worktrees.js';
import { defineCommand } from '../registry/index.js';
import {
  assembleBootstrap,
  readMarkdownWithSchema,
  type BootstrapMetadata,
} from '../bootstrap/prompt.js';
import { archiveStaleTasks } from '../bootstrap/archive-tasks.js';
import { acquireLease } from '../sessions/lease.js';
import { listInitiativeSlugs, resolveSlug, resolveSlugFromCwd } from './_open-helpers.js';

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
  // Frame the bootstrap prompt as ad-hoc work related to the workstream rather
  // than a continuation of its handoff / top task.
  adhoc: z.boolean().optional(),
  // Skip the sibling-session probe (and the lease write that goes with it).
  no_sibling_check: z.boolean().optional(),
  // Internal: `aw` calls this command in-process and holds a `launcher` lease
  // of its own for the same session, so it suppresses the oneshot lease here
  // rather than writing a second one that would then look like a sibling.
  lease_mode: z.literal('defer').optional(),
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
    last_session: z.object({ filename: z.string(), ended: z.string() }).optional(),
    time_since_last_session_human: z.string().optional(),
    open_task_count: z.number().int().nonnegative(),
    recently_done_count: z.number().int().nonnegative(),
    bootstrap_at: z.string(),
    sibling_sessions: z.number().int().nonnegative().optional(),
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

async function loadInitiativeSummary(
  activeRoot: string,
  slug: string,
): Promise<InitiativeSummary | null> {
  const briefPath = path.join(activeRoot, slug, 'brief.md');
  try {
    const { frontmatter } = await readMarkdownWithSchema(briefPath, BriefFrontmatterSchema);
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

async function collectInitiatives(activeRoot: string): Promise<InitiativeSummary[]> {
  const slugs = await listInitiativeSlugs(activeRoot);
  const summaries: InitiativeSummary[] = [];
  for (const slug of slugs) {
    const summary = await loadInitiativeSummary(activeRoot, slug);
    if (summary) summaries.push(summary);
  }
  summaries.sort(compareInitiatives);
  return summaries;
}

async function resolveCwdHint(activeRoot: string, slug: string): Promise<string> {
  const registered = await readRegisteredWorktrees(path.join(activeRoot, slug));
  const preferred = defaultWorktreePath(registered);
  return preferred === null ? path.join(activeRoot, slug) : expandTilde(preferred);
}

/**
 * Claim a `oneshot` lease for the session this bootstrap is about to start.
 *
 * "Oneshot" because this process has no idea how long the session it is
 * priming will live — it prints a prompt and exits — so the lease is a TTL
 * guess that `readLiveLeases` renders with the appropriate hedge. Failure is
 * swallowed: a lease we could not write costs a future warning, whereas a
 * throw here costs the caller their bootstrap.
 */
async function claimOneshotLease(activeRoot: string, slug: string, cwd: string): Promise<void> {
  try {
    await acquireLease({ activeRoot, slug, cwd, mode: 'oneshot' });
  } catch {
    // Advisory only.
  }
}

async function bootstrapInitiative(
  activeRoot: string,
  slug: string,
  opts: {
    offline?: boolean;
    resolvedFrom: 'slug' | 'cwd';
    cwdHintOverride?: string;
    adhoc?: boolean;
    detectSiblings?: boolean;
    deferLease?: boolean;
  },
): Promise<OpenResult & { metadata: BootstrapMetadata }> {
  const briefPath = path.join(activeRoot, slug, 'brief.md');
  const { frontmatter: brief } = await readMarkdownWithSchema(briefPath, BriefFrontmatterSchema);
  // When we resolved via cwd, launch in the worktree the user was standing in,
  // not the brief's default worktree.
  const cwdHint = opts.cwdHintOverride ?? (await resolveCwdHint(activeRoot, slug));
  const archivedTaskIds = await archiveStaleTasks(path.join(activeRoot, slug), {
    retentionDays: ARCHIVE_DONE_AFTER_DAYS,
    now: new Date(),
  });
  const detectSiblings = opts.detectSiblings !== false;
  const { prompt, metadata } = await assembleBootstrap({
    activeRoot,
    slug,
    includeLiveStatus: !opts.offline,
    archivedTaskIds,
    adhoc: opts.adhoc,
    detectSiblings,
    ...(process.env.AW_LEASE_ID ? { ownLeaseId: process.env.AW_LEASE_ID } : {}),
  });
  // After the probe, so this session never warns about itself.
  if (detectSiblings && !opts.deferLease) {
    await claimOneshotLease(activeRoot, slug, cwdHint);
  }
  return {
    slug,
    prompt,
    cwd_hint: cwdHint,
    ...(brief.channels && brief.channels.length > 0 ? { channels: brief.channels } : {}),
    metadata,
    resolved_from: opts.resolvedFrom,
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
      adhoc: {
        long: '--adhoc',
        description:
          'Frame the prompt as ad-hoc work on the workstream (awaiting the user’s task), not a continuation of the handoff / top task.',
      },
      no_sibling_check: {
        long: '--no-sibling-check',
        description:
          'Skip the check for another session already live on this initiative, and do not record a lease for this one.',
      },
    },
    usage:
      'active-work open [slug] [--offline] [--cwd <dir>] [--pick] [--adhoc] [--no-sibling-check]',
  },
  async run(args, ctx) {
    const activeRoot = ctx.activeRoot ?? getActiveRoot();
    // `--offline` is a promise that this bootstrap touches nothing outside the
    // active root; the sibling probe is local I/O, but honoring the flag keeps
    // the fast path a single, predictable read set.
    const detectSiblings = !args.no_sibling_check && !args.offline;
    const deferLease = args.lease_mode === 'defer';

    if (args.slug) {
      const slug = await resolveSlug(activeRoot, args.slug);
      return bootstrapInitiative(activeRoot, slug, {
        offline: args.offline,
        resolvedFrom: 'slug',
        adhoc: args.adhoc,
        detectSiblings,
        deferLease,
      });
    }

    // No slug: infer the initiative from the caller's working directory,
    // unless the caller explicitly asked for the picker. The cwd comes from
    // the caller's args or the interactive-surface context; when neither is
    // set (e.g. a daemon/MCP caller) we skip resolution and show the picker.
    const cwd = args.cwd ?? ctx.cwd;
    if (!args.pick && cwd) {
      const matched = await resolveSlugFromCwd(activeRoot, cwd);
      if (matched) {
        return bootstrapInitiative(activeRoot, matched.slug, {
          offline: args.offline,
          resolvedFrom: 'cwd',
          cwdHintOverride: matched.worktreePath,
          adhoc: args.adhoc,
          detectSiblings,
          deferLease,
        });
      }
    }

    const initiatives = await collectInitiatives(activeRoot);
    return { picker: true, initiatives };
  },
});

export default openCommand;
