/**
 * AW-26 — subagent sidechains as first-class sessions.
 *
 * The behaviour under test is a trap more than a feature: subagent transcripts
 * live at `<project>/<parentSession>/subagents/agent-<id>.jsonl` and every line
 * in them carries a `sessionId` naming the PARENT. Indexing one naively is not
 * a missing-data bug, it is a corruption bug — the parent silently absorbs the
 * subagent's turns. So the first test here asserts the parent's counts are
 * *unchanged* by the presence of a subagent, which is the property that would
 * regress if someone widened discovery without the identity swap.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { runRefresh } from '../../../src/miner/session-index/refresh.js';
import { FIXTURE_CWD } from './fixture.js';

const PARENT = 'parent-sess';
const AGENT_ID = 'a5ae119ee7270e4c7';
const TOOL_USE_ID = 'toolu_01AAtnMQTRQTijoZAR2F1Bc3';

let dir: string;
let root: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-subagent-'));
  root = path.join(dir, 'projects');
  mkdirSync(path.join(root, 'demo'), { recursive: true });
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function render(lines: Record<string, unknown>[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function prompt(sessionId: string, uuid: string, ts: string): Record<string, unknown> {
  return {
    sessionId,
    cwd: FIXTURE_CWD,
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: 'do the thing' },
  };
}

/** The parent: one prompt, one Agent dispatch, and the tool_result that names the child. */
function writeParent({ withBridge = true } = {}): void {
  const lines: Record<string, unknown>[] = [
    prompt(PARENT, 'u1', '2026-08-01T00:00:00.000Z'),
    {
      sessionId: PARENT,
      cwd: FIXTURE_CWD,
      type: 'assistant',
      timestamp: '2026-08-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID,
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'Map the session model' },
          },
        ],
      },
    },
    {
      sessionId: PARENT,
      cwd: FIXTURE_CWD,
      type: 'user',
      timestamp: '2026-08-01T00:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID }] },
      // The only place the dispatch id and the transcript id are stated together.
      ...(withBridge ? { toolUseResult: { isAsync: true, agentId: AGENT_ID } } : {}),
    },
  ];
  writeFileSync(path.join(root, 'demo', `${PARENT}.jsonl`), render(lines), 'utf8');
}

/**
 * The child, at the nested path, with the parent's id in every `sessionId` —
 * the whole point of the fixture. Prompt/assistant pairs, because a turn is
 * only counted once something closes it.
 */
function writeSubagent(turns = 2): void {
  const dirPath = path.join(root, 'demo', PARENT, 'subagents');
  mkdirSync(dirPath, { recursive: true });
  const lines = Array.from({ length: turns }, (_, i) => [
    {
      ...prompt(PARENT, `sub-u${i}`, `2026-08-01T00:01:${String(i * 2).padStart(2, '0')}.000Z`),
      agentId: AGENT_ID,
      isSidechain: true,
    },
    {
      sessionId: PARENT,
      cwd: FIXTURE_CWD,
      agentId: AGENT_ID,
      isSidechain: true,
      type: 'assistant',
      timestamp: `2026-08-01T00:01:${String(i * 2 + 1).padStart(2, '0')}.000Z`,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'done' }],
      },
    },
  ]).flat();
  writeFileSync(path.join(dirPath, `agent-${AGENT_ID}.jsonl`), render(lines), 'utf8');
}

const factsFor = (sessionId: string): number =>
  (
    db.prepare('SELECT COUNT(*) AS n FROM facts WHERE session_id = ?').get(sessionId) as {
      n: number;
    }
  ).n;

const turnsFor = (sessionId: string): number =>
  (
    db.prepare('SELECT turn_count AS n FROM sessions WHERE session_id = ?').get(sessionId) as {
      n: number;
    } | null
  )?.n ?? -1;

describe('subagent sidechains', () => {
  it('does not credit the parent with its subagent’s work', async () => {
    writeParent();
    await runRefresh({ db, root });
    const [turnsAlone, factsAlone] = [turnsFor(PARENT), factsFor(PARENT)];

    writeSubagent(3);
    await runRefresh({ db, root, full: true });

    // The parent is untouched by the arrival of 6 lines of subagent work...
    expect(turnsFor(PARENT)).toBe(turnsAlone);
    expect(factsFor(PARENT)).toBe(factsAlone);
    // ...which is instead attributed to the subagent's own session.
    expect(turnsFor(AGENT_ID)).toBe(3);
    expect(factsFor(AGENT_ID)).toBe(6);
  });

  it('indexes a parent whose child transcript does not exist yet', async () => {
    // Regression: `child_session_id` is a forward reference, and giving it a
    // foreign key made this insert fail — which quarantined the entire parent
    // transcript rather than just dropping the link. Discovery order hid it,
    // because a `<session>/` directory sorts before `<session>.jsonl`.
    writeParent();

    const summary = await runRefresh({ db, root });

    expect(summary).toMatchObject({ indexed: 1, quarantined: 0, errors: [] });
    expect(
      db
        .prepare('SELECT child_session_id FROM subagents WHERE agent_ref = ?')
        .get(`agent:${TOOL_USE_ID}`),
    ).toEqual({ child_session_id: AGENT_ID });
    // The link is recorded even though no such session row exists.
    expect(db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(AGENT_ID)).toBeUndefined();
  });

  it('gives the subagent its own session keyed on agentId, not the parent’s id', async () => {
    writeParent();
    writeSubagent();

    const summary = await runRefresh({ db, root });

    expect(summary.transcripts).toBe(2);
    expect(db.prepare('SELECT session_id FROM sessions ORDER BY session_id').all()).toEqual([
      { session_id: AGENT_ID },
      { session_id: PARENT },
    ]);
  });

  it('records the parent edge from the subagent’s own transcript', async () => {
    writeParent({ withBridge: false });
    writeSubagent();

    await runRefresh({ db, root });

    expect(
      db
        .prepare(
          "SELECT source_ref, target_ref FROM edges WHERE relation = 'spawned' AND target_ref LIKE 'session:%'",
        )
        .all(),
    ).toEqual([{ source_ref: `session:${PARENT}`, target_ref: `session:${AGENT_ID}` }]);
  });

  it('bridges the dispatch to the child transcript via toolUseResult.agentId', async () => {
    writeParent();
    writeSubagent();

    await runRefresh({ db, root });

    expect(
      db
        .prepare(
          'SELECT session_id, child_session_id, agent_type FROM subagents WHERE agent_ref = ?',
        )
        .get(`agent:${TOOL_USE_ID}`),
    ).toEqual({ session_id: PARENT, child_session_id: AGENT_ID, agent_type: 'Explore' });
  });

  it('leaves the agent node dangling when the dispatch names no child', async () => {
    writeParent({ withBridge: false });
    writeSubagent();

    await runRefresh({ db, root });

    // No bridge to invent — but the child still reaches its parent directly,
    // which is what the previous test's `spawned` edge asserts.
    expect(
      db
        .prepare('SELECT child_session_id FROM subagents WHERE agent_ref = ?')
        .get(`agent:${TOOL_USE_ID}`),
    ).toEqual({ child_session_id: null });
  });

  it('resolves the full parent -> dispatch -> child path', async () => {
    writeParent();
    writeSubagent();

    await runRefresh({ db, root });

    expect(
      db
        .prepare(
          `SELECT sp.source_ref AS parent, tr.target_ref AS child
             FROM edges sp
             JOIN edges tr ON tr.source_ref = sp.target_ref AND tr.relation = 'transcribed_in'
            WHERE sp.relation = 'spawned' AND sp.target_ref LIKE 'agent:%'`,
        )
        .all(),
    ).toEqual([{ parent: `session:${PARENT}`, child: `session:${AGENT_ID}` }]);
  });

  it('survives a chunk boundary between the dispatch and its bridge', async () => {
    // The subagent row and the child link come from different lines. Indexing
    // in small chunks is what a resumed watermark does in production, and the
    // upsert is what keeps the link from being dropped on the floor.
    writeParent();
    writeSubagent();

    await runRefresh({ db, root, limit: 1 });
    await runRefresh({ db, root });

    expect(
      db
        .prepare('SELECT child_session_id FROM subagents WHERE agent_ref = ?')
        .get(`agent:${TOOL_USE_ID}`),
    ).toEqual({ child_session_id: AGENT_ID });
  });
});
