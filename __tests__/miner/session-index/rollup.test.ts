import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { indexTranscript } from '../../../src/miner/session-index/quarantine.js';
import { allSessionIds, rollupSessions } from '../../../src/miner/session-index/rollup.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

let dir: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-rollup-'));
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface TurnRow {
  prompt_id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  tool_call_count: number;
  thinking_ms: number;
}

async function build(chunkBytes?: number): Promise<TurnRow[]> {
  const absolutePath = path.join(dir, 'session.jsonl');
  writeFileSync(absolutePath, renderTranscript(FIXTURE_LINES), 'utf8');
  await indexTranscript(db, { absolutePath, displayPath: '~/demo/session.jsonl' }, { chunkBytes });
  rollupSessions(db, allSessionIds(db));
  return db
    .prepare<
      [],
      TurnRow
    >('SELECT prompt_id, started_at, ended_at, duration_ms, tool_call_count, thinking_ms FROM turns ORDER BY turn_index')
    .all();
}

describe('rollupSessions', () => {
  it('closes each turn at the last fact attributed to it', async () => {
    const turns = await build();

    expect(turns.map((t) => t.prompt_id)).toEqual(['p1', 'p2']);
    // p1 owns everything up to (not including) the p2 prompt line.
    expect(turns[0]).toMatchObject({
      started_at: '2026-07-01T00:00:04Z',
      ended_at: '2026-07-01T00:00:18Z',
    });
    expect(turns[0].duration_ms).toBe(14_000);
    // Eight `tool_decision` facts land inside the first turn.
    expect(turns[0].tool_call_count).toBe(8);
    // p2 is the last line: it closes on itself, with no elapsed time.
    expect(turns[1]).toMatchObject({ ended_at: '2026-07-01T00:00:19Z', duration_ms: 0 });
  });

  it('derives thinking_ms from the gaps before each assistant reply', async () => {
    const turns = await build();

    // 04→05 after the prompt, plus 08→09 after the tool_result. The other
    // assistant lines follow assistant lines and contribute nothing.
    expect(turns[0].thinking_ms).toBe(2000);
    expect(turns[1].thinking_ms).toBe(0);
  });

  it('matches a one-pass build when facts arrive across chunk boundaries', async () => {
    const chunked = await build(64);
    db.close();
    db = openSessionIndex(path.join(dir, 'whole.sqlite3'));
    const whole = await build();

    expect(chunked).toEqual(whole);
  });

  it('recomputes rather than accumulates when run repeatedly', async () => {
    const once = await build();

    rollupSessions(db, allSessionIds(db));
    rollupSessions(db, allSessionIds(db));

    const thrice = db
      .prepare<
        [],
        TurnRow
      >('SELECT prompt_id, started_at, ended_at, duration_ms, tool_call_count, thinking_ms FROM turns ORDER BY turn_index')
      .all();
    expect(thrice).toEqual(once);
  });

  it('is a no-op for an empty session list', () => {
    expect(rollupSessions(db, [])).toBe(0);
  });
});
