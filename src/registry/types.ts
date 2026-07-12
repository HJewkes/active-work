import type { ZodSchema } from 'zod';

export interface CommandContext {
  activeRoot: string;
  warnings: string[];
  format: 'human' | 'json';
  // The user's shell working directory, populated by interactive surfaces
  // (the CLI dispatcher and `aw` launcher). Left undefined by the daemon /
  // MCP server, whose process cwd is not the user's — those callers must pass
  // an explicit `cwd` arg to opt into cwd-based resolution.
  cwd?: string;
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
