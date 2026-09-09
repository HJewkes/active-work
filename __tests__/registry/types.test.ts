import { createRegistry } from '@titan-design/registry';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defineCommand,
  register,
  registry,
  type Command,
  type CommandContext,
} from '../../src/registry/index.js';

function makeCommand(name: string): Command<{ value: string }, { echoed: string }> {
  return defineCommand({
    name,
    description: `test command ${name}`,
    args: z.object({ value: z.string() }),
    result: z.object({ echoed: z.string() }),
    async run(args: { value: string }, _ctx: CommandContext) {
      return { echoed: args.value };
    },
  });
}

describe('defineCommand', () => {
  it('returns its argument unchanged (identity)', () => {
    const cmd = makeCommand('test.identity');
    expect(defineCommand(cmd)).toBe(cmd);
  });

  it('binds the product context, so a command reads activeRoot without a type argument', async () => {
    const cmd = defineCommand({
      name: 'test.ctx',
      description: 'reads the product context',
      args: z.object({}),
      result: z.object({ root: z.string() }),
      async run(_args, ctx) {
        return { root: ctx.activeRoot };
      },
    });
    const ctx: CommandContext = { activeRoot: '/tmp/root', warnings: [], format: 'json' };
    expect(await cmd.run({}, ctx)).toEqual({ root: '/tmp/root' });
  });
});

describe('register', () => {
  // The process registry is a singleton the command modules have already
  // populated, so these use names nothing else claims rather than clearing it.
  it('adds a command and is retrievable by name', () => {
    const cmd = makeCommand('test.register.unique');
    register(cmd);
    expect(registry.get('test.register.unique')).toBe(cmd);
    expect(registry.has('test.register.unique')).toBe(true);
  });

  it('throws when registering a duplicate name', () => {
    register(makeCommand('test.register.duplicate'));
    expect(() => register(makeCommand('test.register.duplicate'))).toThrow(
      /Command already registered: test\.register\.duplicate/,
    );
  });

  it('lists commands sorted by name, not by insertion order', () => {
    // Behavior change in AW-a: the module-singleton Map preserved insertion
    // order; the package sorts, so help output and MCP tool lists are stable
    // whatever order the command modules happen to import in.
    const own = createRegistry<CommandContext>();
    for (const name of ['c.three', 'a.one', 'b.two']) own.register(makeCommand(name));
    expect(own.list().map((cmd) => cmd.name)).toEqual(['a.one', 'b.two', 'c.three']);
    expect(own.size).toBe(3);
  });
});
