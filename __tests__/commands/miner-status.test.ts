import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import minerStatus from '../../src/commands/miner-status.js';
import { defaultGraphPath } from '../../src/session-index/graph.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { FIXTURE_LINES, SESSION, renderTranscript } from '../session-index/fixture.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

let configRoot: string;

beforeEach(() => {
  configRoot = mkdtempSync(path.join(os.tmpdir(), 'aw-miner-status-'));
  // A closed daemon: status must not reach the operator's live one.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(configRoot, { recursive: true, force: true });
});

/** One config dir per account, holding `count` transcripts each. */
/** Request ids carry the session id, so the per-transcript rename keeps them unique. */
const BILLED_LINES = FIXTURE_LINES.map((line, i) =>
  line.type === 'assistant' ? { ...line, requestId: `req-${SESSION}-${i}` } : line,
);

function writeCorpus(accounts: Record<string, number>): void {
  const configDirs = Object.entries(accounts).map(([name, count]) => {
    const configDir = path.join(configRoot, name);
    const project = path.join(configDir, 'projects', 'demo');
    mkdirSync(project, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      const body = renderTranscript(BILLED_LINES).replaceAll(SESSION, `${name}-${i}`);
      writeFileSync(path.join(project, `${i}.jsonl`), body, 'utf8');
    }
    return configDir;
  });
  vi.stubEnv('CLAUDE_CONFIG_DIRS', configDirs.join(path.delimiter));
}

function status(): ReturnType<typeof minerStatus.run> {
  return minerStatus.run({}, {} as never);
}

describe('miner status', () => {
  it('miner status reports per-account counts', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 1, agents: 2 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });

      const result = await status();

      expect(result.transcripts.byAccount).toEqual({ default: 1, agents: 2 });
      expect(result.facetBacklog).toBe(0);
      expect(result.episodeBacklog).toBe(0);
    });
  });

  it('counts sessions with no episodes as episode backlog', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 2 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });
      const db = new Database(defaultGraphPath());
      db.prepare('DELETE FROM episode').run();
      db.close();

      const result = await status();

      expect(result.episodeBacklog).toBe(2);
    });
  });

  it('reports the daemon stall gauge and tolerates a daemon that predates it', async () => {
    const index = {
      indexing: true,
      pending: false,
      lastRunAt: '2026-09-24T00:00:00Z',
      lastDurationMs: 1200,
      consecutiveErrors: 0,
    };
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 1 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });
      const answer = (body: object) =>
        vi.fn(async () => new Response(JSON.stringify({ ok: true, index: body })));

      vi.stubGlobal('fetch', answer({ ...index, lastMaxLoopStallMs: 412 }));
      const current = await status();
      vi.stubGlobal('fetch', answer(index));
      const older = await status();

      expect(minerStatus.result.parse(current).daemon?.lastMaxLoopStallMs).toBe(412);
      expect(minerStatus.result.parse(older).daemon).toMatchObject({ indexing: true });
    });
  });

  it('counts indexed transcripts whose audit facet is stale as backlog', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 2 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });
      const db = new Database(defaultGraphPath());
      db.prepare('UPDATE transcript_facet SET version = 0').run();
      db.close();

      const result = await status();

      expect(result.facetBacklog).toBe(2);
    });
  });
});
