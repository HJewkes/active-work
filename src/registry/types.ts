import type { ZodSchema } from 'zod';

export interface CommandContext {
  activeRoot: string;
  warnings: string[];
  format: 'human' | 'json';
}

export interface CliOption {
  long: string;
  short?: string;
  description: string;
  required?: boolean;
}

export interface CliMeta {
  positional?: string[];
  options?: Record<string, CliOption>;
  usage?: string;
}

export interface Command<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  args: ZodSchema<Args>;
  result: ZodSchema<Result>;
  cli?: CliMeta;
  run(args: Args, ctx: CommandContext): Promise<Result>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = Command<any, any>;
export type CommandRegistry = Map<string, AnyCommand>;

export function defineCommand<Args, Result>(
  cmd: Command<Args, Result>,
): Command<Args, Result> {
  return cmd;
}
