import type { AnyCommand, CommandRegistry } from './types.js';

export const registry: CommandRegistry = new Map();

export function register(cmd: AnyCommand): void {
  if (registry.has(cmd.name)) {
    throw new Error(`Command already registered: ${cmd.name}`);
  }
  registry.set(cmd.name, cmd);
}

export type {
  Command,
  AnyCommand,
  CommandRegistry,
  CommandContext,
  CliMeta,
  CliOption,
} from './types.js';
export type { JsonEnvelope } from './json-envelope.js';
export { defineCommand } from './types.js';
export { successEnvelope, errorEnvelope } from './json-envelope.js';
