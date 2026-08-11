import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { runRefresh } from '../../../src/miner/session-index/refresh.js';

/**
 * Regression cover for the order-dependence class of bug: a value that depends
 * on which transcript, or which chunk, happened to be written first. Each of
 * these was found by `tools/eval-session-index.mjs`'s equivalence check against
 * the real corpus, where a full rebuild visits one transcript at a time but an
 * incremental refresh sees a little of every transcript, then a little more.
 */

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-converge-'));
  root = path.join(dir, 'projects', 'demo');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SESSION = 'sess-shared';
const CWD = '/repo/demo';

function line(fields: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: SESSION, cwd: CWD, ...fields };
}

function prompt(uuid: string, ts: string, entrypoint = 'cli'): Record<string, unknown> {
  return line({
    type: 'user',
    uuid,
    timestamp: ts,
    gitBranch: 'feat/x',
    entrypoint,
    message: { role: 'user', content: `do ${uuid}` },
  });
}

function bash(ts: string, command: string): Record<string, unknown> {
  return line({
    type: 'assistant',
    timestamp: ts,
    gitBranch: 'feat/x',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: `t-${ts}`, name: 'Bash', input: { command } }],
    },
  });
}

function prLink(ts: string): Record<string, unknown> {
  return line({
    type: 'pr-link',
    timestamp: ts,
    prNumber: 42,
    prRepository: 'acme/demo',
    prUrl: 'https://github.com/acme/demo/pull/42',
  });
}

const render = (lines: Record<string, unknown>[]): string =>
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

/**
 * `a.jsonl` sorts first but happened *later*, and carries the `gh pr merge`
 * sighting; `b.jsonl` sorts second but happened first and carries the
 * `pr-link`. Discovery visits them alphabetically, so every naturally-ordered
 * value (turn index, branch creation, PR merge state) is observed backwards.
 */
function writeCorpus(): void {
  writeFileSync(
    path.join(root, 'a.jsonl'),
    render([
      prompt('p3', '2026-07-01T03:00:00Z'),
      bash('2026-07-01T03:00:01Z', 'gh pr merge 42 --squash'),
      prompt('p4', '2026-07-01T04:00:00Z'),
    ]),
    'utf8',
  );
  writeFileSync(
    path.join(root, 'b.jsonl'),
    render([
      prompt('p1', '2026-07-01T01:00:00Z', 'sdk-cli'),
      prLink('2026-07-01T01:00:01Z'),
      prompt('p2', '2026-07-01T02:00:00Z'),
    ]),
    'utf8',
  );
}

function query(db: SessionIndexDb) {
  return {
    turns: db.prepare('SELECT prompt_id, turn_index FROM turns ORDER BY turn_index').all() as {
      prompt_id: string;
      turn_index: number;
    }[],
    branch: db.prepare('SELECT created_at FROM branches').get() as { created_at: string },
    session: db.prepare('SELECT started_at, start_type FROM sessions').get() as {
      started_at: string;
      start_type: string | null;
    },
    pr: db.prepare('SELECT state, merged_at FROM prs').get() as {
      state: string | null;
      merged_at: string | null;
    },
  };
}

async function refreshAndRead(dbName: string): Promise<ReturnType<typeof query>> {
  const dbPath = path.join(dir, `${dbName}.sqlite3`);
  await runRefresh({ dbPath, root: path.join(dir, 'projects'), full: true });
  const db = openSessionIndex(dbPath);
  try {
    return query(db);
  } finally {
    db.close();
  }
}

describe('order-independent index state', () => {
  it('numbers turns by when they happened, not by which transcript was read first', async () => {
    writeCorpus();

    const { turns } = await refreshAndRead('turns');

    expect(turns.map((t) => t.prompt_id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(turns.map((t) => t.turn_index)).toEqual([0, 1, 2, 3]);
  });

  it('dates a branch from its earliest sighting across transcripts', async () => {
    writeCorpus();

    const { branch } = await refreshAndRead('branch');

    // b.jsonl is read second but saw the branch two hours earlier.
    expect(branch.created_at).toBe('2026-07-01T01:00:00Z');
  });

  it('takes start_type from the earliest line, not the first transcript read', async () => {
    writeCorpus();

    const { session } = await refreshAndRead('start-type');

    // b.jsonl is read second but holds the session's first line. Two real
    // sessions report both entrypoints in opposite directions, so "how it
    // started" can only mean earliest-timestamp (AW-103).
    expect(session).toEqual({
      started_at: '2026-07-01T01:00:00Z',
      start_type: 'sdk-cli',
    });
  });

  it('takes start_type from the earliest line that carries an entrypoint', async () => {
    // Not simply the earliest line: 413 of 536 real top-level sessions open
    // with a record that has no `entrypoint` at all, and keying start_type to
    // the first line left every one of them null against the live corpus.
    writeFileSync(
      path.join(root, 'c.jsonl'),
      render([prLink('2026-07-01T00:00:00Z'), prompt('p9', '2026-07-01T00:30:00Z', 'sdk-cli')]),
      'utf8',
    );

    const { session } = await refreshAndRead('late-entrypoint');

    expect(session).toEqual({
      started_at: '2026-07-01T00:00:00Z',
      start_type: 'sdk-cli',
    });
  });

  it('applies a merge sighting indexed before the pr-link that names the PR', async () => {
    writeCorpus();

    const { pr } = await refreshAndRead('pr');

    expect(pr).toEqual({ state: 'merged', merged_at: '2026-07-01T03:00:01Z' });
  });

  it('reaches the same state whether the corpus arrives at once or in stages', async () => {
    writeCorpus();
    const whole = await refreshAndRead('whole');

    // Replay: each transcript's first line, then the rest — the interleaving a
    // daemon actually sees while two sessions are running.
    const staged = path.join(dir, 'staged.sqlite3');
    const projects = path.join(dir, 'projects');
    const heads = {
      'a.jsonl': render([prompt('p3', '2026-07-01T03:00:00Z')]),
      'b.jsonl': render([prompt('p1', '2026-07-01T01:00:00Z', 'sdk-cli')]),
    };
    const full = {
      'a.jsonl': render([
        prompt('p3', '2026-07-01T03:00:00Z'),
        bash('2026-07-01T03:00:01Z', 'gh pr merge 42 --squash'),
        prompt('p4', '2026-07-01T04:00:00Z'),
      ]),
      'b.jsonl': render([
        prompt('p1', '2026-07-01T01:00:00Z', 'sdk-cli'),
        prLink('2026-07-01T01:00:01Z'),
        prompt('p2', '2026-07-01T02:00:00Z'),
      ]),
    };
    for (const stage of [heads, full]) {
      for (const [name, body] of Object.entries(stage)) {
        writeFileSync(path.join(root, name), body, 'utf8');
      }
      await runRefresh({ dbPath: staged, root: projects });
    }

    const db = openSessionIndex(staged);
    try {
      expect(query(db)).toEqual(whole);
    } finally {
      db.close();
    }
  });
});
