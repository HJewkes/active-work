/**
 * Human-queue answers take an initiative from the ask: its `meta.initiative`,
 * else its `meta.task` when one initiative files that id, else the asker's cwd from its latest registration
 * before the question. Synthetic `events.db` rows stand in for agent-chat.
 */

import Database from 'better-sqlite3';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractPrecedents } from '../../src/decider/extract.js';
import { readLedgerRows } from '../../src/decider/ledger.js';
import { searchPrecedents } from '../../src/decider/search.js';
import { openGraph } from '../../src/session-index/graph.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const QUESTION = 'Restart the broker tonight?';
const ANSWER = 'Yes, restart it after the release';

let dir: string;
let repo: string;
let eventsDb: string;
let graphPath: string;

interface Ask {
  registeredCwd?: string;
  meta?: Record<string, unknown>;
}

function writeAsk(ask: Ask): void {
  const db = new Database(eventsDb);
  db.exec(
    'CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)',
  );
  const insert = db.prepare(
    'INSERT INTO events (ts, kind, actor, target, msg_id, ref, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const ts = 1_790_000_000_000;
  if (ask.registeredCwd !== undefined) {
    const meta = JSON.stringify({ cwd: ask.registeredCwd });
    insert.run(ts, 'registered', 'cc-main', null, null, null, null, meta);
  }
  const meta = ask.meta === undefined ? null : JSON.stringify(ask.meta);
  insert.run(ts + 1, 'question', 'cc-main', 'human', 'q1', null, QUESTION, meta);
  insert.run(ts + 60_000, 'answer', 'human', 'cc-main', 'a1', 'q1', ANSWER, null);
  db.close();
}

function writeCharter(activeRoot: string, humanOnly: string[]): void {
  const charterDir = path.join(activeRoot, 'claude-channels', 'sources', 'autonomy');
  mkdirSync(charterDir, { recursive: true });
  const frontmatter = `human_only_initiatives: ${JSON.stringify(humanOnly)}`;
  writeFileSync(path.join(charterDir, 'charter.md'), `---\n${frontmatter}\n---\nBody\n`, 'utf8');
}

function registerRepo(activeRoot: string): void {
  const artifacts = `worktrees:\n  - path: ${repo}\n    repo: ${repo}\n    name: main\n`;
  writeFileSync(path.join(activeRoot, 'sample-initiative', 'artifacts.yml'), artifacts, 'utf8');
}

/** A second initiative that also files SI-1, so that id names no single owner. */
function copyInitiative(activeRoot: string, slug: string): void {
  cpSync(path.join(activeRoot, 'sample-initiative'), path.join(activeRoot, slug), {
    recursive: true,
  });
  writeFileSync(path.join(activeRoot, slug, 'artifacts.yml'), 'worktrees: []\n', 'utf8');
}

async function extractQueueRows(activeRoot: string, humanOnly: string[] = []) {
  writeCharter(activeRoot, humanOnly);
  const result = await extractPrecedents({
    activeRoot,
    graphPath,
    eventsDbPath: eventsDb,
  });
  const rows = (await readLedgerRows(activeRoot)).rows.filter((r) => r.source === 'queue');
  const queue = result.sources.find((s) => s.source === 'queue');
  return { rows, queue };
}

async function searchHits(activeRoot: string) {
  const rows = (await readLedgerRows(activeRoot)).rows;
  return searchPrecedents(rows, 'restart the broker', { humanOnly: new Set() });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-queue-initiative-'));
  repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'pkg'), { recursive: true });
  eventsDb = path.join(dir, 'events.db');
  graphPath = path.join(dir, 'graph.sqlite3');
  openGraph(graphPath).db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('human-queue answers in precedent extract', () => {
  it('take the initiative of the asker cwd registered before the question', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerRepo(activeRoot);
      writeAsk({ registeredCwd: path.join(repo, 'pkg') });

      const { rows } = await extractQueueRows(activeRoot);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ initiative: 'sample-initiative', unclaimed: false });
      expect((await searchHits(activeRoot))[0]?.row.answer).toBe(ANSWER);
    });
  });

  it('take the initiative that files the task id named in the ask meta', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeAsk({ meta: { task: 'SI-1', kind: 'decision' } });

      const { rows } = await extractQueueRows(activeRoot);

      expect(rows[0]).toMatchObject({ initiative: 'sample-initiative', unclaimed: false });
    });
  });

  it('take the initiative named in the ask meta over its task id', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      copyInitiative(activeRoot, 'other-initiative');
      writeAsk({ meta: { initiative: 'other-initiative', task: 'ZZ-9' } });

      const { rows } = await extractQueueRows(activeRoot);

      expect(rows[0]).toMatchObject({ initiative: 'other-initiative', unclaimed: false });
    });
  });

  it('stay unclaimed and hidden from search when nothing resolves', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeAsk({ meta: { task: 'ZZ-9' } });

      const { rows } = await extractQueueRows(activeRoot);

      expect(rows[0]).toMatchObject({ initiative: null, unclaimed: true });
      expect(await searchHits(activeRoot)).toEqual([]);
    });
  });

  it('stay unclaimed when two initiatives file the same task id', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      copyInitiative(activeRoot, 'other-initiative');
      writeAsk({ meta: { task: 'SI-1' } });

      const { rows } = await extractQueueRows(activeRoot);

      expect(rows[0]).toMatchObject({ initiative: null, unclaimed: true });
    });
  });

  it('are not written when the asker cwd belongs to a human-only initiative', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerRepo(activeRoot);
      writeAsk({ registeredCwd: repo });

      const { rows, queue } = await extractQueueRows(activeRoot, ['sample-initiative']);

      expect(rows).toEqual([]);
      expect(queue?.excluded['human-only-initiative']).toBe(1);
    });
  });
});
