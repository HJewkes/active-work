import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { staleEpisodeSessions } from '../../src/session-index/episodes.js';
import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import { runRefresh, type RefreshOptions } from '../../src/session-index/refresh.js';
import { renderTranscript } from './fixture.js';

let dir: string;
let root: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-episodes-'));
  root = path.join(dir, 'projects');
  mkdirSync(path.join(root, 'demo'), { recursive: true });
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One prompt and one billed request; `entrypoint` marks a headless run when set. */
function exchange(sessionId: string, ts: string, entrypoint?: string): Record<string, unknown>[] {
  const common = { sessionId, cwd: dir, ...(entrypoint ? { entrypoint } : {}) };
  const requestId = `req-${sessionId}-${ts}`;
  return [
    { ...common, type: 'user', timestamp: ts, message: { role: 'user', content: 'go' } },
    {
      ...common,
      type: 'assistant',
      timestamp: ts,
      requestId,
      message: {
        id: `msg-${requestId}`,
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  ];
}

function transcriptPath(sessionId: string): string {
  return path.join(root, 'demo', `${sessionId}.jsonl`);
}

function writeSession(sessionId: string, ts: string, entrypoint?: string): void {
  writeFileSync(transcriptPath(sessionId), renderTranscript(exchange(sessionId, ts, entrypoint)));
}

function refresh(options: RefreshOptions = {}) {
  return runRefresh({ skipPrOutcomes: true, skipWorkspace: true, graph, root, ...options });
}

function lastEpisodeEnd(sessionId: string): string | undefined {
  return (
    graph.db
      .prepare<
        [string],
        { endedAt: string | null }
      >('SELECT MAX(ended_at) AS endedAt FROM episode WHERE session_id = ?')
      .get(sessionId)?.endedAt ?? undefined
  );
}

describe('episode refresh', () => {
  it('a session with new requests gets its episodes rewritten', async () => {
    writeSession('sess-a', '2026-07-01T00:00:00Z');
    await refresh();
    expect(lastEpisodeEnd('sess-a')).toBe('2026-07-01T00:00:00Z');
    appendFileSync(
      transcriptPath('sess-a'),
      renderTranscript(exchange('sess-a', '2026-07-01T02:00:00Z')),
    );

    const summary = await refresh({ episodeLimit: 0 });

    expect(summary).toMatchObject({ episodesWritten: 1, episodeBacklog: 0 });
    expect(lastEpisodeEnd('sess-a')).toBe('2026-07-01T02:00:00Z');
  });

  it('headless sessions never enter the episode backlog', async () => {
    writeSession('sess-headless', '2026-07-01T00:00:00Z', 'sdk-cli');

    const first = await refresh();
    const second = await refresh();

    expect(first).toMatchObject({ episodesWritten: 0, episodeBacklog: 0 });
    expect(second).toMatchObject({ episodesWritten: 0, episodeBacklog: 0 });
    expect(staleEpisodeSessions(graph.db)).toEqual([]);
    expect(lastEpisodeEnd('sess-headless')).toBeUndefined();
  });

  it('the episode backlog converges to zero over passes', async () => {
    for (const id of ['sess-1', 'sess-2', 'sess-3']) writeSession(id, '2026-07-01T00:00:00Z');
    await refresh();
    // The live graph's starting point: indexed sessions that no pass ever segmented.
    graph.db.prepare('DELETE FROM episode').run();

    const passes = [];
    for (let i = 0; i < 4; i++) passes.push(await refresh({ episodeLimit: 1 }));

    expect(passes.map((pass) => [pass.episodesWritten, pass.episodeBacklog])).toEqual([
      [1, 2],
      [1, 1],
      [1, 0],
      [0, 0],
    ]);
    expect(staleEpisodeSessions(graph.db)).toEqual([]);
  });

  it('segments a new session on the pass that indexes it despite a zero limit', async () => {
    writeSession('sess-new', '2026-07-01T00:00:00Z');

    const summary = await refresh({ episodeLimit: 0 });

    expect(summary).toMatchObject({ episodesWritten: 1, episodeBacklog: 0 });
  });
});
