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
function writeCorpus(accounts: Record<string, number>): void {
  const configDirs = Object.entries(accounts).map(([name, count]) => {
    const configDir = path.join(configRoot, name);
    const project = path.join(configDir, 'projects', 'demo');
    mkdirSync(project, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      const body = renderTranscript(FIXTURE_LINES).replaceAll(SESSION, `${name}-${i}`);
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
      await runRefresh({ skipWorkspace: true });

      const result = await status();

      expect(result.transcripts.byAccount).toEqual({ default: 1, agents: 2 });
      expect(result.facetBacklog).toBe(0);
    });
  });

  it('counts indexed transcripts whose audit facet is stale as backlog', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 2 });
      await runRefresh({ skipWorkspace: true });
      const db = new Database(defaultGraphPath());
      db.prepare('UPDATE transcript_facet SET version = 0').run();
      db.close();

      const result = await status();

      expect(result.facetBacklog).toBe(2);
    });
  });
});
