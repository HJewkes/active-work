import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyDelta, reconcile, resetIndex } from '@titan-design/session-graph';
import { extractTranscript } from '@titan-design/session-read';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { FIXTURE_LINES, SESSION, offsetAfterLine, renderTranscript } from './fixture.js';

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-writer-'));
  // Named after the session id, matching real transcripts — `file-history-*`
  // lines have no `sessionId` field and fall back to this filename.
  transcript = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, renderTranscript(FIXTURE_LINES), 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshGraph(name: string): { graph: SessionGraph; transcriptId: number } {
  const graph = openGraph(path.join(dir, `${name}.sqlite3`));
  return {
    graph,
    transcriptId: graph.transcripts.ensure('~/projects/demo/session.jsonl').sourceId,
  };
}

/** Every derived table, minus the DB-assigned ids that cannot match by design. */
function snapshot(graph: SessionGraph): Record<string, unknown[]> {
  const query = (sql: string) => graph.db.prepare(sql).all();
  return {
    facts: query(
      'SELECT byte_offset, byte_length, event_type, ts, seq, session_id, prompt_id, tool_use_id' +
        ' FROM fact ORDER BY byte_offset',
    ),
    sessions: query(
      'SELECT session_id, started_at, ended_at, cwd, git_branch, ai_title, seed_prompt,' +
        ' turn_count, commit_count, push_count FROM session ORDER BY session_id',
    ),
    usage: query('SELECT * FROM session_model_usage ORDER BY session_id, model'),
    turns: query(
      'SELECT prompt_id, session_id, turn_index, started_at FROM turn ORDER BY turn_index',
    ),
    phases: query(
      'SELECT session_id, from_mode, to_mode, trigger, t_valid, t_invalid FROM permission_phase' +
        ' ORDER BY phase_id',
    ),
    humanEdits: query('SELECT session_id, file_path, ts FROM human_edit ORDER BY edit_id'),
    fileCheckpoints: query(
      'SELECT session_id, file_path, backup_file_name, version, backup_time FROM file_checkpoint' +
        ' ORDER BY checkpoint_id',
    ),
    prs: query('SELECT * FROM pr ORDER BY pr_ref'),
    branches: query('SELECT * FROM branch ORDER BY branch_ref'),
    files: query('SELECT * FROM file ORDER BY file_ref'),
    tasks: query('SELECT * FROM task ORDER BY task_ref'),
    subagents: query(
      'SELECT agent_ref, session_id, agent_type, label FROM subagent ORDER BY agent_ref',
    ),
    artifacts: query('SELECT * FROM artifact ORDER BY artifact_ref'),
    edges: query(
      'SELECT source_ref, relation, target_ref, t_valid, t_expired FROM edge' +
        ' ORDER BY source_ref, relation, target_ref',
    ),
    spans: query(
      'SELECT field, byte_offset, byte_length FROM search_span ORDER BY byte_offset, field',
    ),
  };
}

describe('applyDelta', () => {
  it('produces the same database from two chunked applies as from one', async () => {
    const split = offsetAfterLine(FIXTURE_LINES, 8);
    const whole = freshGraph('whole');
    applyDelta(whole.graph, whole.transcriptId, await extractTranscript(transcript));

    const chunked = freshGraph('chunked');
    const first = await extractTranscript(transcript, { untilByteOffset: split });
    applyDelta(chunked.graph, chunked.transcriptId, first);
    const second = await extractTranscript(transcript, {
      fromByteOffset: first.lastByteOffset,
      priorPrefixHash: first.prefixHash,
    });
    applyDelta(chunked.graph, chunked.transcriptId, second);

    expect(snapshot(chunked.graph)).toEqual(snapshot(whole.graph));
    whole.graph.db.close();
    chunked.graph.db.close();
  });

  it('is idempotent when the same batch is applied twice', async () => {
    const { graph, transcriptId } = freshGraph('idempotent');
    const result = await extractTranscript(transcript);

    applyDelta(graph, transcriptId, result);
    const afterFirst = snapshot(graph);
    applyDelta(graph, transcriptId, result);

    expect(snapshot(graph).facts).toEqual(afterFirst.facts);
    expect(snapshot(graph).edges).toEqual(afterFirst.edges);
    expect(snapshot(graph).phases).toEqual(afterFirst.phases);
    expect(snapshot(graph).spans).toEqual(afterFirst.spans);
    graph.db.close();
  });

  it('accumulates token deltas rather than overwriting the bucket', async () => {
    const { graph, transcriptId } = freshGraph('usage');
    const result = await extractTranscript(transcript);

    applyDelta(graph, transcriptId, result);
    applyDelta(graph, transcriptId, result);

    const usage = graph.db
      .prepare<
        [],
        { input_tokens: number; request_count: number }
      >('SELECT input_tokens, request_count FROM session_model_usage')
      .get();
    expect(usage).toEqual({ input_tokens: 180, request_count: 18 });
    graph.db.close();
  });

  it('collapses repeated mode candidates and closes the superseded phase', async () => {
    const { graph, transcriptId } = freshGraph('phases');
    const lines = [
      ...FIXTURE_LINES,
      { sessionId: 'sess-1', cwd: '/repo/demo', type: 'mode', mode: 'plan', timestamp: 'T1' },
      { sessionId: 'sess-1', cwd: '/repo/demo', type: 'mode', mode: 'build', timestamp: 'T2' },
    ];
    writeFileSync(transcript, renderTranscript(lines), 'utf8');

    applyDelta(graph, transcriptId, await extractTranscript(transcript));

    const phases = graph.db
      .prepare<
        [],
        { to_mode: string; from_mode: string | null; t_invalid: string | null }
      >("SELECT to_mode, from_mode, t_invalid FROM permission_phase WHERE trigger = 'mode' ORDER BY phase_id")
      .all();
    expect(phases).toEqual([
      { to_mode: 'plan', from_mode: null, t_invalid: 'T2' },
      { to_mode: 'build', from_mode: 'plan', t_invalid: null },
    ]);
    graph.db.close();
  });

  it('rebuilds to identical state after resetIndex, without doubling counters', async () => {
    const { graph, transcriptId } = freshGraph('rebuild');
    const result = await extractTranscript(transcript);
    applyDelta(graph, transcriptId, result);
    const before = snapshot(graph);

    resetIndex(graph);
    applyDelta(graph, transcriptId, result);

    expect(snapshot(graph)).toEqual(before);
    graph.db.close();
  });

  it('records a `gh pr merge` observation instead of applying it at write time', async () => {
    const { graph, transcriptId } = freshGraph('merge');

    applyDelta(graph, transcriptId, await extractTranscript(transcript));

    // The sighting is only a number: the `pr_ref` it belongs to may not be
    // indexed yet, so the writer stores the observation and stays out of `prs`.
    expect(graph.db.prepare('SELECT state, merged_at FROM pr').get()).toEqual({
      state: null,
      merged_at: null,
    });
    expect(
      graph.db.prepare('SELECT number, repo_hint, merged_at FROM pr_merge_observation').get(),
    ).toEqual({ number: 42, repo_hint: 'demo', merged_at: '2026-07-01T00:00:16Z' });
    graph.db.close();
  });

  it('folds merge observations into prs regardless of which was indexed first', async () => {
    const { graph, transcriptId } = freshGraph('reconcile');
    applyDelta(graph, transcriptId, await extractTranscript(transcript));

    expect(reconcile(graph).prMerges).toBe(1);

    expect(graph.db.prepare('SELECT state, merged_at FROM pr').get()).toEqual({
      state: 'merged',
      merged_at: '2026-07-01T00:00:16Z',
    });
    // Recompute, not accumulate: re-running changes nothing.
    reconcile(graph);
    expect(graph.db.prepare('SELECT state, merged_at FROM pr').get()).toEqual({
      state: 'merged',
      merged_at: '2026-07-01T00:00:16Z',
    });
    graph.db.close();
  });
});
