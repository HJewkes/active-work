import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { indexTranscript } from '../../../src/miner/session-index/quarantine.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

/**
 * Regression cover for the rotation double-count bug: `resolveStartOffset`
 * detected a rewritten transcript and re-read it from byte 0, but nothing
 * consumed `restartedFromZero`, so the accumulating upserts (`turn_count`,
 * token buckets, commit/push counts) added a second copy of every counter on
 * each incremental pass.
 */

let dir: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-purge-'));
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const absolutePath = (): string => path.join(dir, 'rotate.jsonl');
const input = (): { absolutePath: string; displayPath: string } => ({
  absolutePath: absolutePath(),
  displayPath: '~/projects/demo/rotate.jsonl',
});

function write(body: string): void {
  writeFileSync(absolutePath(), body, 'utf8');
}

function counts(): Record<string, number> {
  const session = db
    .prepare<[], { turn_count: number; commit_count: number; push_count: number }>(
      'SELECT turn_count, commit_count, push_count FROM sessions',
    )
    .get()!;
  const scalar = (sql: string): number =>
    (db.prepare<[], { n: number }>(sql).get() as { n: number }).n;
  return {
    ...session,
    facts: scalar('SELECT COUNT(*) AS n FROM facts'),
    turns: scalar('SELECT COUNT(*) AS n FROM turns'),
    edges: scalar('SELECT COUNT(*) AS n FROM edges'),
    spans: scalar('SELECT COUNT(*) AS n FROM searchable_spans'),
    humanEdits: scalar('SELECT COUNT(*) AS n FROM human_edits'),
    phases: scalar('SELECT COUNT(*) AS n FROM permission_phases'),
    subagents: scalar('SELECT COUNT(*) AS n FROM subagents'),
    inputTokens: scalar('SELECT COALESCE(SUM(input_tokens), 0) AS n FROM session_model_usage'),
    requests: scalar('SELECT COALESCE(SUM(request_count), 0) AS n FROM session_model_usage'),
  };
}

describe('rotation purge', () => {
  it('re-indexes a rewritten transcript without doubling any counter', async () => {
    write(renderTranscript(FIXTURE_LINES));
    await indexTranscript(db, input());
    const afterFirst = counts();

    // Rewrite the prefix in place: same line count, different bytes, so the
    // stored prefix hash no longer matches and the extractor restarts at 0.
    const rotated = FIXTURE_LINES.map((line) => ({ ...line, rotated: true }));
    write(renderTranscript(rotated));
    const outcome = await indexTranscript(db, input());

    expect(outcome.status).toBe('indexed');
    expect(counts()).toEqual(afterFirst);
  });

  it('leaves no orphaned rows pointing at the purged transcript', async () => {
    write(renderTranscript(FIXTURE_LINES));
    await indexTranscript(db, input());

    write(renderTranscript(FIXTURE_LINES.slice(0, 4).map((l) => ({ ...l, rotated: true }))));
    await indexTranscript(db, input());

    const orphans = db
      .prepare<[], { n: number }>(
        `SELECT (SELECT COUNT(*) FROM edges e WHERE e.fact_id NOT IN (SELECT fact_id FROM facts))
              + (SELECT COUNT(*) FROM turns t WHERE t.fact_id_start NOT IN (SELECT fact_id FROM facts))
              + (SELECT COUNT(*) FROM searchable_spans s WHERE s.fact_id NOT IN (SELECT fact_id FROM facts))
              + (SELECT COUNT(*) FROM human_edits h WHERE h.fact_id NOT IN (SELECT fact_id FROM facts))
              AS n`,
      )
      .get()!;
    expect(orphans.n).toBe(0);
  });

  it('is idempotent across repeated rotations', async () => {
    write(renderTranscript(FIXTURE_LINES));
    await indexTranscript(db, input());
    const baseline = counts();

    for (let i = 0; i < 3; i++) {
      write(renderTranscript(FIXTURE_LINES.map((l) => ({ ...l, pass: i }))));
      await indexTranscript(db, input());
    }

    expect(counts()).toEqual(baseline);
  });
});
