import { describe, expect, it } from 'vitest';
import { stashSpawnContext, takeSpawnContext } from '../../src/utils/agent-chat-hook-state.js';

describe('agent-chat hook state', () => {
  it('round-trips a stashed spawn context and deletes it on read', async () => {
    const context = {
      slug: 'demo-initiative',
      sessionId: 'sess-1',
      name: 'scout',
      started: '2026-08-01T00:00:00.000Z',
    };
    await stashSpawnContext('agent-1', context);

    const taken = await takeSpawnContext('agent-1');
    expect(taken).toEqual(context);

    // Second read finds nothing — the file was deleted on the first read.
    expect(await takeSpawnContext('agent-1')).toBeNull();
  });

  it('returns null for an agentId that was never stashed', async () => {
    expect(await takeSpawnContext('never-spawned')).toBeNull();
  });

  it('keeps two agents fully independent', async () => {
    await stashSpawnContext('agent-a', {
      slug: 'init-a',
      sessionId: 's-a',
      name: 'scout-a',
      started: '2026-08-01T00:00:00.000Z',
    });
    await stashSpawnContext('agent-b', {
      slug: 'init-b',
      sessionId: 's-b',
      name: 'scout-b',
      started: '2026-08-01T00:00:01.000Z',
    });

    expect((await takeSpawnContext('agent-a'))?.slug).toBe('init-a');
    expect((await takeSpawnContext('agent-b'))?.slug).toBe('init-b');
  });
});
