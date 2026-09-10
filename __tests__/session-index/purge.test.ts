import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { indexTranscript } from '@titan-design/session-graph';
import type { DiscoveredTranscript } from '@titan-design/session-read';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

/**
 * Regression cover for the rotation double-count bug (AW-90): a rewritten
 * transcript is re-read from byte 0, and the accumulating upserts
 * (`turn_count`, token buckets, commit/push counts) add a second copy of every
 * counter unless the transcript's derived rows are purged first.
 *
 * `verifyHash` is on throughout because a rotation that leaves the file the
 * same length or longer is only detectable by re-hashing the consumed prefix.
 */

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-purge-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const absolutePath = (): string => path.join(dir, 'rotate.jsonl');
const input = (): DiscoveredTranscript => ({
  projectDir: 'demo',
  absolutePath: absolutePath(),
  displayPath: '~/projects/demo/rotate.jsonl',
  subagentId: null,
});

function write(body: string): void {
  writeFileSync(absolutePath(), body, 'utf8');
}

function counts(): Record<string, number> {
  const session = graph.db
    .prepare<
      [],
      { turn_count: number; commit_count: number; push_count: number }
    >('SELECT turn_count, commit_count, push_count FROM session')
    .get()!;
  const scalar = (sql: string): number =>
    (graph.db.prepare<[], { n: number }>(sql).get() as { n: number }).n;
  return {
    ...session,
    facts: scalar('SELECT COUNT(*) AS n FROM fact'),
    turns: scalar('SELECT COUNT(*) AS n FROM turn'),
    edges: scalar('SELECT COUNT(*) AS n FROM edge'),
    spans: scalar('SELECT COUNT(*) AS n FROM search_span'),
    humanEdits: scalar('SELECT COUNT(*) AS n FROM human_edit'),
    phases: scalar('SELECT COUNT(*) AS n FROM permission_phase'),
    subagents: scalar('SELECT COUNT(*) AS n FROM subagent'),
    inputTokens: scalar('SELECT COALESCE(SUM(input_tokens), 0) AS n FROM session_model_usage'),
    requests: scalar('SELECT COALESCE(SUM(request_count), 0) AS n FROM session_model_usage'),
  };
}

describe('rotation purge', () => {
  it('re-indexes a rewritten transcript without doubling any counter', async () => {
    write(renderTranscript(FIXTURE_LINES));
    await indexTranscript(graph, input(), { verifyHash: true });
    const afterFirst = counts();

    // Rewrite the prefix in place: same line count, different bytes, so the
    // stored prefix hash no longer matches and the read restarts at 0.
    const rotated = FIXTURE_LINES.map((line) => ({ ...line, rotated: true }));
    write(renderTranscript(rotated));
    const outcome = await indexTranscript(graph, input(), { verifyHash: true });

    expect(outcome.status).toBe('rewound');
    expect(counts()).toEqual(afterFirst);
  });

  it('leaves no orphaned rows pointing at the purged transcript', async () => {
    write(renderTranscript(FIXTURE_LINES));
    await indexTranscript(graph, input(), { verifyHash: true });

    write(renderTranscript(FIXTURE_LINES.slice(0, 4).map((l) => ({ ...l, rotated: true }))));
    await indexTranscript(graph, input(), { verifyHash: true });

    const orphans = graph.db
      .prepare<[], { n: number }>(
        `SELECT (SELECT COUNT(*) FROM edge e WHERE e.fact_id NOT IN (SELECT fact_id FROM fact))
              + (SELECT COUNT(*) FROM turn t WHERE t.fact_id_start NOT IN (SELECT fact_id FROM fact))
              + (SELECT COUNT(*) FROM search_span s WHERE NOT EXISTS (
                   SELECT 1 FROM fact f WHERE f.transcript_id = s.source_id
                     AND s.byte_offset >= f.byte_offset
                     AND s.byte_offset < f.byte_offset + f.byte_length))
              + (SELECT COUNT(*) FROM human_edit h WHERE h.fact_id NOT IN (SELECT fact_id FROM fact))
              AS n`,
      )
      .get()!;
    expect(orphans.n).toBe(0);
  });

  it('is idempotent across repeated rotations', async () => {
    write(renderTranscript(FIXTURE_LINES));
    await indexTranscript(graph, input(), { verifyHash: true });
    const baseline = counts();

    for (let i = 0; i < 3; i++) {
      write(renderTranscript(FIXTURE_LINES.map((l) => ({ ...l, pass: i }))));
      await indexTranscript(graph, input(), { verifyHash: true });
    }

    expect(counts()).toEqual(baseline);
  });
});
