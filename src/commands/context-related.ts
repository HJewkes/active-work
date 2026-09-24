/**
 * Workspace context related to a piece of text (TP-85).
 *
 * The fuzzy counterpart to `context graph`: that command is exact-id joins
 * only, this one ranks by relevance. Callers pass the text a trigger already
 * carries and get a bounded, fail-open list of openable hits back.
 */
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { SEARCH_CLASSES } from '../search/classes.js';
import {
  fileHitLog,
  HIT_TRIGGERS,
  servedHitEntries,
  type HitLogWriter,
} from '../search/hit-log.js';
import {
  RELATED_DEFAULT_BUDGET,
  RELATED_DEFAULT_CLASSES,
  RELATED_DEFAULT_LIMIT,
  relatedContext,
  type RelatedResult,
} from '../search/related.js';
import { nowIso } from '../utils/today.js';

const CLASS_NAMES = SEARCH_CLASSES.map((cls) => cls.name);

const ArgsSchema = z.object({
  for: z.string(),
  initiative: z.string().min(1).optional(),
  limit: z.number().int().positive().max(50).optional(),
  budget: z.number().int().positive().optional(),
  classes: z
    .array(z.string())
    .refine((names) => names.every((name) => CLASS_NAMES.includes(name)), {
      message: `classes must be drawn from: ${CLASS_NAMES.join(', ')}`,
    })
    .optional(),
  exclude: z.array(z.string()).optional(),
  // Only a caller that renders the hits into a prompt names one; a human query logs nothing.
  trigger: z.enum(HIT_TRIGGERS).optional(),
});

const HitSchema = z.object({
  ref: z.string(),
  class: z.string(),
  initiative: z.string().nullable(),
  title: z.string().nullable(),
  path: z.string().nullable(),
  excerpt: z.string().nullable(),
  byteOffset: z.number().nullable(),
  byteLength: z.number().nullable(),
});

const ResultSchema = z.object({
  hits: z.array(HitSchema),
  // Why the list is short or empty. Never an error: a caller renders what it got.
  degraded: z.array(z.object({ source: z.string(), reason: z.string(), message: z.string() })),
  query: z.object({ terms: z.array(z.string()), expression: z.string() }),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

async function logServed(args: Args, result: RelatedResult, hitLog: HitLogWriter): Promise<void> {
  if (args.trigger === undefined) return;
  const context = {
    ts: nowIso(),
    slug: args.initiative ?? '',
    trigger: args.trigger,
    query: args.for,
  };
  const failure = await hitLog(servedHitEntries(result.hits, context));
  if (failure !== null)
    result.degraded.push({ source: 'hit-log', reason: 'error', message: failure });
}

export interface RelatedDeps {
  activeRoot: string;
  hitLog?: HitLogWriter;
  dbPath?: string;
}

/** The command's body, with the index and hit log injectable so tests never touch the live ones. */
export async function runRelated(args: Args, deps: RelatedDeps): Promise<RelatedResult> {
  const result = await relatedContext({
    text: args.for,
    activeRoot: deps.activeRoot,
    ...(deps.dbPath !== undefined ? { dbPath: deps.dbPath } : {}),
    ...(args.initiative !== undefined ? { initiative: args.initiative } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.budget !== undefined ? { budget: args.budget } : {}),
    ...(args.classes !== undefined ? { classes: args.classes } : {}),
    ...(args.exclude !== undefined ? { exclude: args.exclude } : {}),
  });
  await logServed(args, result, deps.hitLog ?? fileHitLog());
  return result;
}

export default defineCommand<Args, Result>({
  name: 'context.related',
  description:
    'Rank workspace notes, sources, tasks and session records against a piece of text; bounded, and empty rather than failing when the index is unavailable',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      for: { long: '--for', description: 'The text to find related context for (required)' },
      initiative: {
        long: '--initiative',
        description: 'Bias towards this initiative. A boost, never a filter.',
      },
      limit: {
        long: '--limit',
        description: `Most hits to return (default ${RELATED_DEFAULT_LIMIT})`,
      },
      budget: {
        long: '--budget',
        description: `Most characters across all hits (default ${RELATED_DEFAULT_BUDGET})`,
      },
      classes: {
        long: '--classes',
        description: `Comma-separated classes (default ${RELATED_DEFAULT_CLASSES.join(',')})`,
      },
      exclude: {
        long: '--exclude',
        description: 'Comma-separated refs the caller already shows',
      },
      trigger: {
        long: '--trigger',
        description: `Log the returned hits as served, under this trigger (${HIT_TRIGGERS.join(', ')})`,
      },
    },
    usage:
      'context related --for <text> [--initiative <slug>] [--limit 6] [--budget 1500] [--classes notes,sources,tasks,sessions] [--exclude <ref>,<ref>] [--trigger spawn]',
  },
  async run(args, ctx) {
    return runRelated(args, { activeRoot: ctx.activeRoot });
  },
});
