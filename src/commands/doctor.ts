import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { runDoctor, type CheckStatus } from '../doctor.js';
import { color } from '../utils/color.js';

/**
 * `active-work doctor` — health-check the local install.
 *
 * Returns a structured report (exit 0; scripts read the `ok` field) and, in
 * human mode, prints a readable table to stderr like `active-work setup`.
 */

const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'warn', 'fail']),
  detail: z.string(),
});

const ResultSchema = z.object({
  ok: z.boolean(),
  checks: z.array(CheckSchema),
});
type Result = z.infer<typeof ResultSchema>;

function badge(status: CheckStatus): string {
  if (status === 'ok') return color.green('OK  ');
  if (status === 'warn') return color.yellow('WARN');
  return color.red('FAIL');
}

export default defineCommand<Args, Result>({
  name: 'doctor',
  description:
    'Health-check the install: Node, active root, daemon, MCP registration, skill, and supervision.',
  args: ArgsSchema,
  result: ResultSchema,
  async run(_args, ctx) {
    const report = await runDoctor();
    if (ctx.format !== 'json') {
      process.stderr.write(color.bold('active-work doctor') + '\n');
      for (const check of report.checks) {
        process.stderr.write(`  ${badge(check.status)} ${check.name} — ${check.detail}\n`);
      }
      const summary = report.ok
        ? color.green('All checks passed (warnings are advisory).')
        : color.red('One or more checks failed.');
      process.stderr.write(summary + '\n');
    }
    return report;
  },
});
