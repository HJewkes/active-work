import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnClaudeResume } from '../src/aw.js';

type SpawnCall = { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined };

function fakeSpawn(calls: SpawnCall[]): typeof spawn {
  return ((cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: opts.env });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  }) as unknown as typeof spawn;
}

afterEach(() => vi.unstubAllEnvs());

describe('spawnClaudeResume', () => {
  it('sets CLAUDE_CONFIG_DIR when the session lives under a profile', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const calls: SpawnCall[] = [];
    await spawnClaudeResume(
      'sess-1',
      '/synthetic/cwd',
      false,
      '/synthetic/profiles/agents',
      fakeSpawn(calls),
    );
    expect(calls[0]?.args).toEqual(['--resume', 'sess-1']);
    expect(calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe('/synthetic/profiles/agents');
  });

  it('drops an inherited CLAUDE_CONFIG_DIR for a default-dir session without mutating process.env', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/synthetic/other-profile');
    const calls: SpawnCall[] = [];
    await spawnClaudeResume('sess-2', '/synthetic/cwd', false, undefined, fakeSpawn(calls));
    expect(calls[0]?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(process.env.CLAUDE_CONFIG_DIR).toBe('/synthetic/other-profile');
  });

  it('overrides an inherited CLAUDE_CONFIG_DIR with the profile the session was found under', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/synthetic/other-profile');
    const calls: SpawnCall[] = [];
    await spawnClaudeResume(
      'sess-3',
      '/synthetic/cwd',
      false,
      '/synthetic/agents',
      fakeSpawn(calls),
    );
    expect(calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe('/synthetic/agents');
  });
});
