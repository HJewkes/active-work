import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type * as SessionAnalytics from '@titan-design/session-analytics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRelated } from '../../src/commands/context-related.js';
import { yieldToReaders } from '../../src/server/session-index-watch.js';
import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import { runRefresh, type RefreshOptions } from '../../src/session-index/refresh.js';
import { renderTranscript } from '../session-index/fixture.js';
import { scaffold } from '../workspace-index/fixture.js';

/** Stands in for the measured 420 to 525 ms `writeEpisodes` costs per session on the live graph. */
const SESSION_COST_MS = 200;
const STALE_SESSIONS = 10;

const slowEpisodes = vi.hoisted(() => ({
  enabled: false,
  firstCallAt: 0,
  onFirstCall: (): void => {},
}));

vi.mock('@titan-design/session-analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionAnalytics>();
  return {
    ...actual,
    writeEpisodes: (...args: Parameters<typeof actual.writeEpisodes>) => {
      if (slowEpisodes.enabled) {
        if (slowEpisodes.firstCallAt === 0) {
          slowEpisodes.firstCallAt = performance.now();
          slowEpisodes.onFirstCall();
        }
        const until = performance.now() + SESSION_COST_MS * args[1].length;
        while (performance.now() < until);
      }
      return actual.writeEpisodes(...args);
    },
  };
});

let dir: string;
let activeRoot: string;
let corpus: string;
let dbPath: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-related-during-refresh-'));
  activeRoot = path.join(dir, 'active');
  corpus = path.join(dir, 'projects');
  dbPath = path.join(dir, 'graph.sqlite3');
  mkdirSync(path.join(corpus, 'demo'), { recursive: true });
  scaffold(activeRoot);
  graph = openGraph(dbPath);
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
  Object.assign(slowEpisodes, { enabled: false, firstCallAt: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeSession(sessionId: string): void {
  const common = { sessionId, cwd: dir };
  const requestId = `req-${sessionId}`;
  const ts = '2026-07-01T00:00:00Z';
  const lines = [
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
  writeFileSync(path.join(corpus, 'demo', `${sessionId}.jsonl`), renderTranscript(lines));
}

function refresh(options: RefreshOptions = {}) {
  return runRefresh({ skipPrOutcomes: true, graph, root: corpus, activeRoot, ...options });
}

/** An indexed corpus whose sessions all wait for episodes, as the live backlog does. */
async function staleEpisodeBacklog(): Promise<void> {
  for (let i = 0; i < STALE_SESSIONS; i++) writeSession(`sess-${i}`);
  await refresh();
  graph.db.prepare('DELETE FROM episode').run();
}

describe('context.related during a daemon refresh pass', () => {
  it('related answers while a refresh pass is running', async () => {
    await staleEpisodeBacklog();
    const pass = { done: false };
    const firstSession = new Promise<void>((resolve) => {
      slowEpisodes.onFirstCall = resolve;
    });
    slowEpisodes.enabled = true;

    const running = refresh({ yieldPoint: yieldToReaders }).finally(() => {
      pass.done = true;
    });
    await firstSession;
    const result = await runRelated(
      { for: 'the alpha lesson', initiative: 'alpha' },
      { activeRoot, dbPath, hitLog: async () => null },
    );
    const answeredAfterMs = performance.now() - slowEpisodes.firstCallAt;
    const passRunningAtAnswer = !pass.done;
    const summary = await running;

    // One chunk already running plus the query; a second chunk means the pass cut in.
    expect(answeredAfterMs).toBeLessThan(2 * SESSION_COST_MS);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(passRunningAtAnswer).toBe(true);
    expect(summary.episodesWritten).toBe(STALE_SESSIONS);
  });
});
