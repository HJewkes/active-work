import { describe, expect, it } from 'vitest';
import { buildChannelArgs, buildClaudeArgs } from '../src/launcher-args.js';

describe('buildChannelArgs', () => {
  it('returns no args when channels is undefined or empty', () => {
    expect(buildChannelArgs(undefined)).toEqual([]);
    expect(buildChannelArgs([])).toEqual([]);
  });

  it('normalizes a bare server name to server:<name>', () => {
    expect(buildChannelArgs(['voltras'])).toEqual([
      '--dangerously-load-development-channels',
      'server:voltras',
    ]);
  });

  it('passes explicit server:/plugin: targets through untouched', () => {
    expect(buildChannelArgs(['server:voltras', 'plugin:foo@market'])).toEqual([
      '--dangerously-load-development-channels',
      'server:voltras',
      'plugin:foo@market',
    ]);
  });

  it('collects all targets under a single variadic flag', () => {
    const args = buildChannelArgs(['a', 'b', 'c']);
    const flags = args.filter(
      (a) => a === '--dangerously-load-development-channels',
    );
    expect(flags).toHaveLength(1);
  });
});

describe('buildClaudeArgs', () => {
  // Regression: --dangerously-load-development-channels is variadic, so without
  // a `--` terminator the flag swallows the prompt as a channel target and the
  // real prompt collides. The prompt MUST come after `--`.
  it('places the prompt after a `--` terminator so channels cannot swallow it', () => {
    const args = buildClaudeArgs('the bootstrap prompt', ['voltras']);
    expect(args).toEqual([
      '--dangerously-load-development-channels',
      'server:voltras',
      '--',
      'the bootstrap prompt',
    ]);
    // The prompt is the final arg and is preceded immediately by `--`.
    expect(args.at(-1)).toBe('the bootstrap prompt');
    expect(args.at(-2)).toBe('--');
  });

  it('still terminates with `--` when there are no channels', () => {
    expect(buildClaudeArgs('hello')).toEqual(['--', 'hello']);
  });

  it('keeps a prompt that starts with a dash from being parsed as a flag', () => {
    const args = buildClaudeArgs('-- not a flag', ['voltras']);
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('-- not a flag');
  });
});
