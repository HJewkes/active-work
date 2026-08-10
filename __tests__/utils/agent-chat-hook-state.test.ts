import { describe, expect, it } from 'vitest';
import {
  peekSpawnContext,
  stashSpawnContext,
  takeSpawnContext,
} from '../../src/utils/agent-chat-hook-state.js';

const base = {
  slug: 'demo-initiative',
  sessionId: 'sess-1',
  name: 'scout',
  started: '2026-08-01T00:00:00.000Z',
  parentSessionId: null,
  profile: null,
  briefing: null,
};

describe('agent-chat hook state', () => {
  it('round-trips a stashed spawn context and deletes it on read', async () => {
    const context = { ...base, parentSessionId: 'parent-sess', profile: 'explorer' };
    await stashSpawnContext('agent-1', context);

    const taken = await takeSpawnContext('agent-1');
    expect(taken).toEqual(context);

    // Second read finds nothing — the file was deleted on the first read.
    expect(await takeSpawnContext('agent-1')).toBeNull();
  });

  it('defaults the linkage fields for a stash written before they existed', async () => {
    // A file left on disk by the previous version must still parse rather than
    // stranding a peer that was mid-flight across the upgrade.
    await stashSpawnContext('agent-old', {
      slug: 'demo-initiative',
      sessionId: 'sess-old',
      name: 'scout',
      started: '2026-08-01T00:00:00.000Z',
    } as never);

    expect(await takeSpawnContext('agent-old')).toEqual({
      slug: 'demo-initiative',
      sessionId: 'sess-old',
      name: 'scout',
      started: '2026-08-01T00:00:00.000Z',
      parentSessionId: null,
      profile: null,
      briefing: null,
    });
  });

  it('peek reads a live parent without consuming its entry', async () => {
    await stashSpawnContext('agent-parent', { ...base, sessionId: 'parent-sess' });

    expect((await peekSpawnContext('agent-parent'))?.sessionId).toBe('parent-sess');
    // Still there — the parent's own on_complete has yet to claim it.
    expect((await peekSpawnContext('agent-parent'))?.sessionId).toBe('parent-sess');
    expect((await takeSpawnContext('agent-parent'))?.sessionId).toBe('parent-sess');
    expect(await peekSpawnContext('agent-parent')).toBeNull();
  });

  it('returns null for an agentId that was never stashed', async () => {
    expect(await takeSpawnContext('never-spawned')).toBeNull();
  });

  it('keeps two agents fully independent', async () => {
    await stashSpawnContext('agent-a', { ...base, slug: 'init-a', sessionId: 's-a' });
    await stashSpawnContext('agent-b', { ...base, slug: 'init-b', sessionId: 's-b' });

    expect((await takeSpawnContext('agent-a'))?.slug).toBe('init-a');
    expect((await takeSpawnContext('agent-b'))?.slug).toBe('init-b');
  });
});
