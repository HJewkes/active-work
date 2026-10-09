import { z } from 'zod';
import type { CliOption, CommandContext } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';

export const QuietArg = z.boolean().optional();

export function quietOption(example: string): CliOption {
  return {
    long: '--quiet',
    description: `Print one line, e.g. "${example}"; --json gives the full task`,
  };
}

export const TaskOrLineSchema = z.union([TaskSchema, z.string()]);

export type TaskOrLine = z.infer<typeof TaskOrLineSchema>;

/**
 * The line only replaces human output. MCP and HTTP always run with
 * format 'json', so a quiet flag passed there is ignored and they keep the
 * task object; the CLI rejects --quiet with --json before a command runs.
 */
export function quietOr(
  quiet: boolean | undefined,
  ctx: CommandContext,
  task: Task,
  line: () => string,
): TaskOrLine {
  return quiet === true && ctx.format === 'human' ? `${line()}\n` : task;
}
