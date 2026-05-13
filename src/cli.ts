#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import type { ZodSchema, ZodTypeAny } from 'zod';
import { registry } from './registry/index.js';
import './commands/index.js'; // populates the registry via side effect
import { getActiveRoot } from './utils/paths.js';
import { formatError, EXIT } from './errors.js';
import {
  successEnvelope,
  errorEnvelope,
  type AnyCommand,
  type CliMeta,
  type CommandContext,
} from './registry/index.js';
import { color } from './utils/color.js';
import { appendUsage } from './utils/usage-log.js';

/**
 * Look up the inner zod type, skipping optional/nullable/default wrappers.
 *
 * Returns the unwrapped def type string (e.g. `'string'`, `'number'`,
 * `'array'`, `'boolean'`, `'enum'`) so the dispatcher can decide how to
 * coerce a raw commander value before zod parsing.
 */
function unwrapZodType(schema: ZodTypeAny | undefined): string | undefined {
  if (!schema) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let def = (schema as any)?._zod?.def;
  while (def && (def.type === 'optional' || def.type === 'nullable' || def.type === 'default')) {
    def = def.innerType?._zod?.def;
  }
  return def?.type as string | undefined;
}

/**
 * Pull the per-field zod schema out of a top-level `z.object({...})`.
 *
 * Returns `undefined` when the schema isn't an object or the field is
 * absent — callers fall back to treating the value as a plain string.
 */
function fieldSchema(args: ZodSchema, name: string): ZodTypeAny | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape = (args as any)?._zod?.def?.shape;
  if (!shape) return undefined;
  return shape[name] as ZodTypeAny | undefined;
}

/** Coerce a raw commander value (string | boolean | undefined) to the type implied by zod. */
function coerce(value: unknown, zodType: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (zodType === 'boolean') {
    return value === true || value === 'true';
  }
  if (zodType === 'number') {
    if (typeof value === 'number') return value;
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (zodType === 'array') {
    if (Array.isArray(value)) return value;
    return String(value)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return value;
}

/** Split a registry command name like `task.add` into commander sub-command path parts. */
function splitName(name: string): string[] {
  return name.split('.');
}

/**
 * Walk/create a chain of `commander` sub-commands for the given group
 * parts (e.g. `['task']` for `task.add`). Returns the leaf parent so the
 * caller can attach the final action sub-command.
 */
function ensureGroup(root: Command, parts: string[]): Command {
  let current = root;
  for (const part of parts) {
    const existing = current.commands.find((c) => c.name() === part);
    if (existing) {
      current = existing;
      continue;
    }
    const next = current
      .command(part)
      .description(`${part} commands`);
    current = next;
  }
  return current;
}

/** Convert a hyphenated CLI flag/positional name to its `args` camelCase / snake_case key. */
function flagToKey(long: string): string {
  // `--ship-target` -> `ship_target` to match zod schemas (snake_case
  // convention in this codebase).
  return long.replace(/^--/, '').replace(/-/g, '_');
}

interface InvocationOutput {
  exitCode: number;
  success: boolean;
}

async function emitSuccess(
  cmd: AnyCommand,
  result: unknown,
  ctx: CommandContext,
): Promise<void> {
  if (ctx.format === 'json') {
    process.stdout.write(
      JSON.stringify(successEnvelope(result, ctx.warnings)) + '\n',
    );
    return;
  }
  // Human mode: pretty-print JSON for now. Commands can layer richer
  // output later by checking ctx.format themselves.
  if (result !== undefined && result !== null) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  // Touch cmd to avoid an unused-parameter warning when extending later.
  void cmd;
}

function emitError(message: string, code: number, format: 'human' | 'json'): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(errorEnvelope(message, code)) + '\n');
    return;
  }
  process.stderr.write(color.red('error: ' + message) + '\n');
}

/**
 * Build the action handler for a single registry command.
 *
 * Captures positionals + options into a plain object, coerces values to
 * the types implied by the command's zod schema, runs the schema, then
 * invokes `cmd.run`. Always writes a usage-log line and exits with the
 * appropriate sysexits code.
 */
function makeAction(
  cmd: AnyCommand,
  rootProgram: Command,
): (...handlerArgs: unknown[]) => Promise<void> {
  const meta: CliMeta = cmd.cli ?? {};
  const positionalNames = meta.positional ?? [];

  return async (...handlerArgs: unknown[]) => {
    const start = Date.now();
    const optsFromCommander = (handlerArgs[positionalNames.length] ??
      {}) as Record<string, unknown>;
    const rootOpts = rootProgram.opts() as { json?: boolean };
    const format: 'human' | 'json' = rootOpts.json ? 'json' : 'human';

    const raw: Record<string, unknown> = {};

    // Positionals: handlerArgs[0..positionalNames.length-1]
    positionalNames.forEach((pname, i) => {
      const value = handlerArgs[i];
      if (value !== undefined) {
        const t = unwrapZodType(fieldSchema(cmd.args, pname));
        raw[pname] = coerce(value, t);
      }
    });

    // Options
    if (meta.options) {
      for (const [key, opt] of Object.entries(meta.options)) {
        const flagKey = flagToKey(opt.long);
        // commander camelCases long flag names, dropping leading --.
        const commanderKey = flagKey.replace(/_([a-z])/g, (_, c: string) =>
          c.toUpperCase(),
        );
        const value =
          optsFromCommander[commanderKey] ?? optsFromCommander[flagKey];
        if (value !== undefined) {
          const t = unwrapZodType(fieldSchema(cmd.args, key));
          raw[key] = coerce(value, t);
        }
      }
    }

    const ctx: CommandContext = {
      activeRoot: getActiveRoot(),
      warnings: [],
      format,
    };

    const result = await invoke(cmd, raw, ctx, format);
    const duration = Date.now() - start;
    await appendUsage({
      ts: new Date().toISOString(),
      command: cmd.name,
      args: raw,
      duration_ms: duration,
      success: result.success,
      exit_code: result.exitCode,
    });
    process.exit(result.exitCode);
  };
}

async function invoke(
  cmd: AnyCommand,
  raw: Record<string, unknown>,
  ctx: CommandContext,
  format: 'human' | 'json',
): Promise<InvocationOutput> {
  let parsed: unknown;
  try {
    parsed = cmd.args.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitError(`invalid arguments: ${message}`, EXIT.USAGE, format);
    return { exitCode: EXIT.USAGE, success: false };
  }

  try {
    const result = await cmd.run(parsed, ctx);
    await emitSuccess(cmd, result, ctx);
    return { exitCode: EXIT.OK, success: true };
  } catch (err) {
    const { message, code } = formatError(err);
    emitError(message, code, format);
    return { exitCode: code, success: false };
  }
}

/**
 * Translate a registry `CliMeta` description of a single option into the
 * commander option-spec string. Boolean zod fields become bare flags
 * (`--flag`); everything else takes an option-argument (`--flag <value>`).
 */
function buildOptionFlags(
  cmd: AnyCommand,
  key: string,
  opt: CliMeta['options'] extends infer M
    ? M extends Record<string, infer O>
      ? O
      : never
    : never,
): string {
  const zodType = unwrapZodType(fieldSchema(cmd.args, key));
  const short = opt.short ? `${opt.short}, ` : '';
  if (zodType === 'boolean') {
    return `${short}${opt.long}`;
  }
  return `${short}${opt.long} <value>`;
}

/** Attach one registry command as a sub-command under its appropriate parent. */
function attachCommand(root: Command, cmd: AnyCommand): void {
  const parts = splitName(cmd.name);
  const leafName = parts[parts.length - 1]!;
  const parent = ensureGroup(root, parts.slice(0, -1));
  const sub = parent.command(leafName).description(cmd.description);

  const meta: CliMeta = cmd.cli ?? {};
  for (const pname of meta.positional ?? []) {
    const zType = unwrapZodType(fieldSchema(cmd.args, pname));
    const optional =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fieldSchema(cmd.args, pname) as any)?._zod?.def?.type === 'optional';
    const display = optional ? `[${pname}]` : `<${pname}>`;
    sub.argument(display, `${pname}${zType ? ` (${zType})` : ''}`);
  }

  if (meta.options) {
    for (const [key, opt] of Object.entries(meta.options)) {
      const flags = buildOptionFlags(cmd, key, opt);
      if (opt.required) {
        sub.requiredOption(flags, opt.description);
      } else {
        sub.option(flags, opt.description);
      }
    }
  }

  sub.action(makeAction(cmd, root));
}

function buildProgram(): Command {
  const program = new Command();
  // exitOverride must be set before sub-commands are created so the
  // setting is inherited via `copyInheritedSettings`. Sub-commands then
  // throw a `CommanderError` instead of calling `process.exit` directly.
  program.exitOverride();
  program
    .name('active-work')
    .description('active-work CLI — durable workspace state for engineering work')
    .version('0.1.0')
    .option('--json', 'emit machine-readable JSON envelope on stdout')
    .addHelpText(
      'after',
      '\nRun `active-work <command> --help` for command-specific options.\n' +
        'Tip: `aw [slug]` launches Claude with the bootstrap prompt.\n',
    );

  // Sort commands so help output is stable.
  const cmds = Array.from(registry.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const cmd of cmds) {
    attachCommand(program, cmd);
  }

  return program;
}

/**
 * Entry point. Builds the program and dispatches argv. Commander errors
 * (e.g. unknown command, missing required option) are mapped to the
 * USAGE exit code; everything else surfaces via the per-command action.
 */
export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander already wrote to stderr for help / version. Just exit.
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
        process.exit(0);
      }
      process.exit(EXIT.USAGE);
    }
    const { message, code } = formatError(err);
    emitError(message, code, 'human');
    process.exit(code);
  }
}

void main(process.argv);
