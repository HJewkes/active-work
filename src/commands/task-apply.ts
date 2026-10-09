import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { getActiveRoot } from '../utils/paths.js';
import { today } from '../utils/today.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { loadEdgeIndex } from '../tasks/edge-index.js';
import { groupPlan, hasEdgeOps, parsePlan, type PlanEntry } from './_task-apply-plan.js';
import { applySlug, type LineResult } from './_task-apply-run.js';

// Strict on purpose, like `task note`: the verb takes a plan and two flags, nothing else.
const ArgsSchema = z
  .object({
    plan: z.string().min(1),
    dry_run: z.boolean().optional(),
    report: z.string().min(1).optional(),
  })
  .strict();

type Args = z.infer<typeof ArgsSchema>;

const OUTCOMES = ['applied', 'unchanged', 'missing', 'failed'] as const;

const CountsSchema = z.object({
  applied: z.number(),
  unchanged: z.number(),
  missing: z.number(),
  failed: z.number(),
});

const LineSchema = z.object({
  slug: z.string(),
  id: z.string(),
  result: z.enum(OUTCOMES),
  changes: z.array(z.string()),
  error: z.string().optional(),
});

const SummarySchema = z.object({
  dry_run: z.boolean(),
  counts: CountsSchema,
  slugs: z.array(z.object({ slug: z.string(), counts: CountsSchema })),
  results: z.array(LineSchema),
});

const ResultSchema = z.union([SummarySchema, z.string()]);

type Counts = z.infer<typeof CountsSchema>;
type Summary = z.infer<typeof SummarySchema>;
type Line = z.infer<typeof LineSchema>;

async function readPlan(cwd: string, plan: string): Promise<string> {
  try {
    return await fs.readFile(path.resolve(cwd, plan), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError(`Plan file not found: ${plan}`);
    }
    throw err;
  }
}

function failedLine(entry: PlanEntry): LineResult {
  const { index, slug, id, error } = entry;
  return { index, slug, id, result: 'failed', changes: [], error };
}

async function applyPlan(entries: PlanEntry[], dryRun: boolean): Promise<Line[]> {
  // Tag-only plans skip the whole-root read, so a malformed file elsewhere cannot block them.
  const edges = hasEdgeOps(entries) ? await loadEdgeIndex() : undefined;
  const run = { date: today(), dryRun, edges };
  const lines = entries.filter((entry) => entry.error !== undefined).map(failedLine);
  for (const [slug, tasks] of groupPlan(entries)) {
    lines.push(...(await applySlug(slug, tasks, run)));
  }
  return lines.sort((a, b) => a.index - b.index).map(({ index: _index, ...line }) => line);
}

function countOutcomes(lines: Line[]): Counts {
  const counts: Counts = { applied: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const line of lines) counts[line.result] += 1;
  return counts;
}

function summarize(lines: Line[], dryRun: boolean): Summary {
  const slugs = [...new Set(lines.map((line) => line.slug))].map((slug) => ({
    slug,
    counts: countOutcomes(lines.filter((line) => line.slug === slug)),
  }));
  return { dry_run: dryRun, counts: countOutcomes(lines), slugs, results: lines };
}

function formatCounts(counts: Counts): string {
  return OUTCOMES.map((outcome) => `${outcome} ${counts[outcome]}`).join('  ');
}

function renderText(summary: Summary): string {
  const rows = summary.slugs.map(
    ({ slug, counts }) => `${slug || '(no slug)'}  ${formatCounts(counts)}`,
  );
  const total = `${summary.dry_run ? 'total (dry run)' : 'total'}  ${formatCounts(summary.counts)}`;
  return [...rows, total].join('\n') + '\n';
}

async function writeReport(cwd: string, report: string, lines: Line[]): Promise<void> {
  const body = lines.map((line) => JSON.stringify(line)).join('\n');
  await fs.writeFile(path.resolve(cwd, report), lines.length > 0 ? `${body}\n` : '');
}

function warnUnknownKeys(ctx: CommandContext, keys: string[]): void {
  if (keys.length === 0) return;
  const notice = `Ignored unknown plan line keys: ${keys.join(', ')}`;
  ctx.warnings.push(notice);
  if (ctx.format !== 'json') process.stderr.write(`${notice}\n`);
}

function failureError(summary: Summary): ValidationError {
  const first = summary.results.find((line) => line.result === 'failed');
  const detail = first ? `; first: ${first.slug}/${first.id}: ${first.error ?? ''}` : '';
  return new ValidationError(
    `${summary.counts.failed} plan line(s) failed (${formatCounts(summary.counts)})${detail}`,
  );
}

export default defineCommand<Args, z.infer<typeof ResultSchema>>({
  name: 'task.apply',
  description:
    'Apply a JSONL plan of tag, note, done, set_parent and add_dep ops to many tasks: one lock per initiative, one write per task, idempotent',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['plan'],
    options: {
      dry_run: { long: '--dry-run', description: 'Compute and report every result; write no task' },
      report: { long: '--report', description: 'Write one JSONL result line per plan line here' },
    },
  },
  async run(args, ctx) {
    getActiveRoot();
    const cwd = ctx.cwd ?? process.cwd();
    const { entries, unknownKeys } = parsePlan(await readPlan(cwd, args.plan));
    warnUnknownKeys(ctx, unknownKeys);
    const summary = summarize(
      await applyPlan(entries, args.dry_run === true),
      args.dry_run === true,
    );
    if (args.report !== undefined) await writeReport(cwd, args.report, summary.results);
    if (summary.counts.failed > 0) {
      if (ctx.format !== 'json') process.stdout.write(renderText(summary));
      throw failureError(summary);
    }
    return ctx.format === 'json' ? summary : renderText(summary);
  },
});
