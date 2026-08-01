import { afterEach, describe, expect, it } from 'vitest';
import {
  handleOnComplete,
  resetWrapRunner,
  setWrapRunner,
} from '../../src/commands/hooks-agent-chat-complete.js';
import { stashSpawnContext } from '../../src/utils/agent-chat-hook-state.js';

interface WrapCall {
  args: string[];
}

function capturingWrapRunner(exitCode = 0): { calls: WrapCall[] } {
  const calls: WrapCall[] = [];
  setWrapRunner((args) => {
    calls.push({ args });
    return Promise.resolve({ code: exitCode, stderr: '' });
  });
  return { calls };
}

afterEach(() => {
  resetWrapRunner();
});

describe('handleOnComplete', () => {
  it('is a no-op when no context was stashed for this agentId', async () => {
    const { calls } = capturingWrapRunner();

    const result = await handleOnComplete({
      agentId: 'never-spawned',
      code: 0,
      signal: null,
      inferred: false,
    });

    expect(result).toEqual({ recorded: false, slug: null });
    expect(calls).toHaveLength(0);
  });

  it('is a no-op for a payload with no agentId', async () => {
    const { calls } = capturingWrapRunner();
    expect(await handleOnComplete(null)).toEqual({ recorded: false, slug: null });
    expect(await handleOnComplete({ code: 0 })).toEqual({ recorded: false, slug: null });
    expect(calls).toHaveLength(0);
  });

  it('calls wrap with track:adhoc using the stashed context, on a real exit', async () => {
    await stashSpawnContext('agent-1', {
      slug: 'demo-init',
      sessionId: 'sess-abc',
      name: 'scout',
      started: '2026-08-01T00:00:00.000Z',
    });
    const { calls } = capturingWrapRunner();

    const result = await handleOnComplete({
      agentId: 'agent-1',
      code: 0,
      signal: null,
      inferred: false,
    });

    expect(result).toEqual({ recorded: true, slug: 'demo-init' });
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args ?? [];
    expect(args[0]).toBe('wrap');
    expect(args[1]).toBe('demo-init');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('sess-abc');
    expect(args).toContain('--track');
    expect(args[args.indexOf('--track') + 1]).toBe('adhoc');
    expect(args).toContain('--no-loops');
    expect(args).toContain('--no-notes');
    expect(args).toContain('--no-tasks');
    const bodyIndex = args.indexOf('--body');
    expect(args[bodyIndex + 1]).toContain('scout');
    expect(args[bodyIndex + 1]).toContain('code 0');
  });

  it('describes an inferred exit distinctly in the body', async () => {
    await stashSpawnContext('agent-2', {
      slug: 'demo-init',
      sessionId: 'sess-xyz',
      name: 'scout',
      started: '2026-08-01T00:00:00.000Z',
    });
    const { calls } = capturingWrapRunner();

    await handleOnComplete({ agentId: 'agent-2', code: null, signal: null, inferred: true });

    const args = calls[0]?.args ?? [];
    const body = args[args.indexOf('--body') + 1] ?? '';
    expect(body).toMatch(/inferred/);
  });

  it('consumes the stashed context — a second call for the same agentId is a no-op', async () => {
    await stashSpawnContext('agent-3', {
      slug: 'demo-init',
      sessionId: 'sess-once',
      name: 'scout',
      started: '2026-08-01T00:00:00.000Z',
    });
    const { calls } = capturingWrapRunner();

    await handleOnComplete({ agentId: 'agent-3', code: 0, signal: null, inferred: false });
    const second = await handleOnComplete({
      agentId: 'agent-3',
      code: 0,
      signal: null,
      inferred: false,
    });

    expect(second).toEqual({ recorded: false, slug: null });
    expect(calls).toHaveLength(1);
  });

  it('throws when wrap exits non-zero, so the hook process reports failure', async () => {
    await stashSpawnContext('agent-4', {
      slug: 'demo-init',
      sessionId: 'sess-fail',
      name: 'scout',
      started: '2026-08-01T00:00:00.000Z',
    });
    setWrapRunner(() => Promise.resolve({ code: 1, stderr: 'boom' }));

    await expect(
      handleOnComplete({ agentId: 'agent-4', code: 0, signal: null, inferred: false }),
    ).rejects.toThrow(/boom/);
  });
});
