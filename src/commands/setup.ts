import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { runSetup } from '../setup/steps.js';
import { color } from '../utils/color.js';

/**
 * `aw setup` — interactive wizard that walks a fresh machine to a working state.
 *
 * Each step runs in sequence and short-circuits on the first hard failure.
 * `--yes` skips interactive prompts (assumes no for daemon start / ingestion).
 * `--update` re-runs idempotently and may overwrite the config stub.
 */

const ArgsSchema = z.object({
  update: z.boolean().optional(),
  yes: z.boolean().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const StepSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  done: z.boolean().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

const ResultSchema = z.object({
  banner: z.string(),
  steps: z.array(StepSchema),
});
type Result = z.infer<typeof ResultSchema>;

function printStep(step: Result['steps'][number]): void {
  if (step.ok) {
    const mark = color.green('OK');
    const msg = step.message ?? '';
    process.stderr.write(`  ${mark} ${step.name}${msg ? ` — ${msg}` : ''}\n`);
  } else {
    const mark = color.red('FAIL');
    process.stderr.write(`  ${mark} ${step.name} — ${step.error ?? 'failed'}\n`);
  }
}

export default defineCommand<Args, Result>({
  name: 'setup',
  description:
    'Interactive wizard: verifies Node, scaffolds directories, registers the MCP server, and optionally starts the daemon and walks through ingestion.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      update: {
        long: '--update',
        description: 'Re-run setup idempotently (may overwrite the config stub).',
      },
      yes: {
        long: '--yes',
        short: '-y',
        description: 'Skip all prompts; use defaults (no daemon, no ingestion).',
      },
    },
  },
  async run(args, ctx) {
    const banner = color.bold('active-work setup');
    if (ctx.format !== 'json') {
      process.stderr.write(banner + '\n');
    }
    const report = await runSetup({
      yes: args.yes ?? false,
      update: args.update ?? false,
    });
    if (ctx.format !== 'json') {
      for (const step of report.steps) printStep(step);
    }
    const failed = report.steps.find((s) => !s.ok);
    if (failed) {
      throw new Error(`setup failed at step '${failed.name}': ${failed.error}`);
    }
    return report;
  },
});
