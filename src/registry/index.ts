import { createRegistry, type CommandRegistry } from '@titan-design/registry';
import type { AnyCommand, CommandContext } from './types.js';

/**
 * One registry instance for the process. The package models a registry as an
 * instance rather than a module singleton so a product can own several;
 * active-work has exactly one, and this module is where that choice lives.
 */
export const registry: CommandRegistry<CommandContext> = createRegistry<CommandContext>();

export function register(cmd: AnyCommand): void {
  registry.register(cmd);
}

export type { CommandRegistry } from '@titan-design/registry';
export type { Command, AnyCommand, CommandContext, CliMeta, CliOption } from './types.js';
export { defineCommand } from './types.js';
export type { JsonEnvelope } from '@titan-design/registry';
export { successEnvelope, errorEnvelope } from '@titan-design/registry';
