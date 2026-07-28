import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { UsageError } from '../errors.js';
import { CURRENT_VERSION } from '../migrations/index.js';
import { applyV2ToV3, planV2ToV3 } from '../migrations/v2-to-v3-open-loops.js';
import { readSchemaVersion, writeSchemaVersion } from '../schemas/state.js';
import { color } from '../utils/color.js';

/**
 * `active-work migrate --dry-run` — report exactly what the pending v2→v3
 * open-loops migration would change, per initiative, writing nothing.
 *
 * The migration otherwise runs unattended at startup. This surface exists
 * because v3 rewrites session history: it is reviewed before it runs, and a
 * dry run is the review artifact. Applying is opt-in (`--apply`) so the
 * command cannot mutate data by being run bare.
 */

const ArgsSchema = z.object({
  dry_run: z.boolean().optional(),
  apply: z.boolean().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const SessionSchema = z.object({
  kind: z.enum(['open', 'abandon']),
  action: z.enum(['write', 'exists']),
  file: z.string(),
  ended: z.string(),
  loops: z.number().int().nonnegative(),
  resolves: z.number().int().nonnegative(),
});

const InitiativeSchema = z.object({
  slug: z.string(),
  sessions: z.array(SessionSchema),
  task_seq_backfill: z.number().int().positive().nullable(),
  brief_repairs: z.array(z.string()),
  brief_blocked: z.string().optional(),
  handoff: z.enum(['archive-and-remove', 'archive-exists', 'absent']),
  note: z.string().optional(),
});

const ResultSchema = z.object({
  applied: z.boolean(),
  proposal: z.string(),
  initiatives: z.array(InitiativeSchema),
  repairs: z.array(
    z.object({ action: z.string(), file: z.string(), detail: z.string() }),
  ),
  uncovered: z.array(z.string()),
});
type Result = z.infer<typeof ResultSchema>;

type Initiative = z.infer<typeof InitiativeSchema>;

function describe(
  plan: Awaited<ReturnType<typeof planV2ToV3>>,
  applied: boolean,
): Result {
  const initiatives: Initiative[] = plan.initiatives.map((i) => ({
    slug: i.slug,
    sessions: i.sessions.map((s) => ({
      kind: s.kind,
      action: s.exists ? ('exists' as const) : ('write' as const),
      file: s.path,
      ended: s.frontmatter.ended,
      loops: s.frontmatter.next_steps.length,
      resolves: s.frontmatter.resolves.length,
    })),
    task_seq_backfill: i.brief?.taskSeq ?? null,
    brief_repairs: i.brief?.repairs ?? [],
    ...(i.briefBlocked === undefined ? {} : { brief_blocked: i.briefBlocked }),
    handoff: i.handoff,
    ...(i.uncoveredReason === undefined ? {} : { note: i.uncoveredReason }),
  }));
  return {
    applied,
    proposal: plan.proposalOrigin,
    initiatives,
    repairs: plan.repairs.map((r) => ({
      action: r.action,
      file: r.file,
      detail: r.detail,
    })),
    uncovered: initiatives.filter((i) => i.sessions.length === 0).map((i) => i.slug),
  };
}

function renderSession(s: Initiative['sessions'][number]): string {
  const what =
    s.kind === 'open'
      ? `opens ${s.loops} loop(s)`
      : `abandons ${s.resolves} loop(s)`;
  const verb = s.action === 'exists' ? 'already present — skip' : 'write';
  return `session (${s.kind}) ${verb}: ${s.file} — ${what}, ended ${s.ended}`;
}

function renderInitiative(i: Initiative): string {
  const parts: string[] = i.sessions.map(renderSession);
  if (i.sessions.length === 0) {
    parts.push(color.yellow(`NO SYNTHETIC SESSION — ${i.note}`));
  }
  for (const repair of i.brief_repairs) parts.push(`brief repair: ${repair}`);
  if (i.task_seq_backfill !== null) parts.push(`task_seq -> ${i.task_seq_backfill}`);
  if (i.brief_blocked !== undefined) {
    parts.push(color.yellow(`brief NOT rewritten — ${i.brief_blocked}`));
  }
  if (i.handoff === 'archive-and-remove') {
    parts.push('handoff.md -> sources/handoff-archive.md, then delete');
  }
  if (i.handoff === 'archive-exists') {
    parts.push(color.yellow('handoff.md kept — sources/handoff-archive.md already exists'));
  }
  if (parts.length === 0) parts.push('nothing to do');
  return `  ${color.bold(i.slug)}\n${parts.map((p) => `    - ${p}`).join('\n')}`;
}

function render(result: Result): string {
  const lines = [
    color.bold(result.applied ? 'active-work migrate (applied)' : 'active-work migrate --dry-run'),
    `  proposal: ${result.proposal}`,
    ...result.initiatives.map(renderInitiative),
    color.bold('  repairs'),
    ...result.repairs.map((r) => `    - ${r.action}: ${r.file} — ${r.detail}`),
  ];
  if (result.uncovered.length > 0) {
    lines.push(
      color.yellow(
        `  ${result.uncovered.length} initiative(s) have no proposal entry and will keep ` +
          `their next-actions only in sources/handoff-archive.md: ${result.uncovered.join(', ')}`,
      ),
    );
  }
  return lines.join('\n') + '\n';
}

export default defineCommand<Args, Result>({
  name: 'migrate',
  description: 'Preview (or apply) the pending v2→v3 open-loops migration.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      dry_run: { long: '--dry-run', description: 'Report what would change; write nothing' },
      apply: { long: '--apply', description: 'Actually run the migration' },
    },
    usage: 'active-work migrate --dry-run | --apply',
  },
  async run(args, ctx) {
    if (args.apply !== true) {
      const plan = await planV2ToV3(ctx.activeRoot);
      const result = describe(plan, false);
      if (ctx.format !== 'json') process.stderr.write(render(result));
      return result;
    }
    if (args.dry_run === true) {
      throw new UsageError('--dry-run and --apply are mutually exclusive');
    }
    // This command runs one step of the chain. Stamping v3 over data that has
    // not been through v1→v2 would strand the artifacts migration forever.
    const before = await readSchemaVersion(ctx.activeRoot);
    if (before !== CURRENT_VERSION - 1) {
      throw new UsageError(
        `--apply runs only the v2→v3 step, but this root is at schema v${before}. ` +
          'Run any earlier migrations first (they run automatically on the next command).',
      );
    }
    const plan = await planV2ToV3(ctx.activeRoot);
    await applyV2ToV3(ctx.activeRoot, plan);
    await writeSchemaVersion(ctx.activeRoot, CURRENT_VERSION);
    const result = describe(plan, true);
    if (ctx.format !== 'json') process.stderr.write(render(result));
    return result;
  },
});
