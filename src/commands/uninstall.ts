import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { runUninstall } from '../setup/steps.js';
import { color } from '../utils/color.js';

/**
 * `active-work uninstall` — reverse what setup did. Asks for confirmation before each
 * destructive action (or --yes to skip prompts). Does NOT touch the active
 * root: that's operator data, and removing it should be a deliberate act.
 */

const ArgsSchema = z.object({
  yes: z.boolean().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const StepSchema = z.object({
  name: z.string(),
  done: z.boolean(),
  message: z.string().optional(),
  error: z.string().optional(),
});

const ResultSchema = z.object({
  steps: z.array(StepSchema),
  activeRootPreservedAt: z.string(),
});
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'uninstall',
  description:
    'Reverse what setup did: remove the skill, stop the daemon, unregister MCP. Preserves the active root.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      yes: {
        long: '--yes',
        short: '-y',
        description: 'Skip all prompts; assume yes.',
      },
    },
  },
  async run(args, ctx) {
    const report = await runUninstall({ yes: args.yes ?? false });
    if (ctx.format !== 'json') {
      for (const step of report.steps) {
        const mark = step.error ? color.red('FAIL') : color.green('OK');
        const trailing = step.error ?? step.message ?? '';
        process.stderr.write(
          `  ${mark} ${step.name}${trailing ? ` — ${trailing}` : ''}\n`,
        );
      }
      process.stderr.write(
        '\n' +
          color.dim(
            `Your active root at ${report.activeRootPreservedAt} is preserved. ` +
              'Remove manually if you want.',
          ) +
          '\n',
      );
    }
    return report;
  },
});
