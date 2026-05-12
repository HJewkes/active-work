import { describe, it, expect, beforeEach } from 'vitest';
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
    const result = defineCommand(cmd);
    expect(result).toBe(cmd);
  });
});

describe('register', () => {
  beforeEach(() => {
    registry.clear();
  });

  it('adds a command and is retrievable by name', () => {
    const cmd = makeCommand('task.add');
    register(cmd);
    expect(registry.get('task.add')).toBe(cmd);
  });

  it('throws when registering duplicate name', () => {
    register(makeCommand('task.add'));
    expect(() => register(makeCommand('task.add'))).toThrow(
      /Command already registered: task\.add/,
    );
  });

  it('preserves insertion order via registry.values()', () => {
    const a = makeCommand('a.one');
    const b = makeCommand('b.two');
    const c = makeCommand('c.three');
    register(a);
    register(b);
    register(c);
    const names = Array.from(registry.values()).map((cmd) => cmd.name);
    expect(names).toEqual(['a.one', 'b.two', 'c.three']);
  });
});
