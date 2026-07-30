import type { SessionIndexDb } from './db.js';
import type { ExtractResult } from '../../schemas/session-index.js';

/**
 * Applies one transcript's extracted batch to the index.
 *
 * Everything for a transcript lands in a single better-sqlite3 transaction so
 * a crash mid-write can never leave rows committed behind a stale watermark
 * (or a watermark ahead of its rows).
 *
 * Row kinds split three ways:
 *  - append-only, made idempotent by a unique index: `facts`, `edges`, `spans`
 *  - accumulating upserts: `sessions`, `session_model_usage`, `turns`
 *  - insert-if-absent upserts keyed by `*_ref`: the per-asset tables
 *
 * `permission_phases` is the exception: it is append-only but *collapsing* —
 * see `applyPhases`.
 */

const INSERT_FACT = `
  INSERT INTO facts (transcript_id, byte_offset, byte_length, event_type, ts, seq, session_id,
                     prompt_id, tool_use_id, agent_id, parent_agent_id, workflow_run_id)
  VALUES (@transcriptId, @byteOffset, @byteLength, @eventType, @ts, @seq, @sessionId,
          @promptId, @toolUseId, @agentId, @parentAgentId, @workflowRunId)
  ON CONFLICT (transcript_id, byte_offset) DO NOTHING`;

const UPSERT_SESSION = `
  INSERT INTO sessions (session_id, transcript_id, started_at, ended_at, start_type, cwd,
                        git_branch, ai_title, seed_prompt, cli_version, turn_count,
                        commit_count, push_count)
  VALUES (@sessionId, @transcriptId, @startedAt, @endedAt, @startType, @cwd, @gitBranch,
          @aiTitle, @seedPrompt, @cliVersion, @turnDelta, @commitDelta, @pushDelta)
  ON CONFLICT (session_id) DO UPDATE SET
    started_at  = MIN(COALESCE(started_at, excluded.started_at), COALESCE(excluded.started_at, started_at)),
    ended_at    = MAX(COALESCE(ended_at, excluded.ended_at), COALESCE(excluded.ended_at, ended_at)),
    start_type  = COALESCE(start_type, excluded.start_type),
    cwd         = COALESCE(excluded.cwd, cwd),
    git_branch  = COALESCE(git_branch, excluded.git_branch),
    ai_title    = COALESCE(excluded.ai_title, ai_title),
    seed_prompt = COALESCE(seed_prompt, excluded.seed_prompt),
    cli_version = COALESCE(excluded.cli_version, cli_version),
    turn_count   = turn_count + excluded.turn_count,
    commit_count = commit_count + excluded.commit_count,
    push_count   = push_count + excluded.push_count`;

const UPSERT_USAGE = `
  INSERT INTO session_model_usage (session_id, model, input_tokens, output_tokens,
                                   cache_read_tokens, cache_creation_tokens, thinking_tokens,
                                   request_count)
  VALUES (@sessionId, @model, @inputTokens, @outputTokens, @cacheReadTokens,
          @cacheCreationTokens, @thinkingTokens, @requestCount)
  ON CONFLICT (session_id, model) DO UPDATE SET
    input_tokens          = input_tokens + excluded.input_tokens,
    output_tokens         = output_tokens + excluded.output_tokens,
    cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    thinking_tokens       = thinking_tokens + excluded.thinking_tokens,
    request_count         = request_count + excluded.request_count`;

// turn_index is DB-assigned: an extractor resuming mid-file cannot know how
// many turns preceded its chunk.
const UPSERT_TURN = `
  INSERT INTO turns (prompt_id, session_id, turn_index, started_at, ended_at, tool_call_count,
                     fact_id_start)
  VALUES (@promptId, @sessionId,
          (SELECT COALESCE(MAX(turn_index), -1) + 1 FROM turns WHERE session_id = @sessionId),
          @startedAt, @endedAt, @toolCallCount, @factId)
  ON CONFLICT (prompt_id) DO UPDATE SET
    ended_at        = MAX(COALESCE(ended_at, excluded.ended_at), COALESCE(excluded.ended_at, ended_at)),
    tool_call_count = tool_call_count + excluded.tool_call_count`;

const INSERT_EDGE = `
  INSERT INTO edges (source_ref, relation, target_ref, t_valid, fact_id, confidence)
  VALUES (@sourceRef, @relation, @targetRef, @tValid, @factId, @confidence)
  ON CONFLICT (source_ref, relation, target_ref) WHERE t_expired IS NULL DO NOTHING`;

const ASSET_UPSERTS: Record<string, string> = {
  prs: `INSERT INTO prs (pr_ref, number, repo, title, state, url, merged_at)
        VALUES (@prRef, @number, @repo, @title, @state, @url, @mergedAt)
        ON CONFLICT (pr_ref) DO UPDATE SET
          title = COALESCE(title, excluded.title), state = COALESCE(state, excluded.state),
          url = COALESCE(url, excluded.url), merged_at = COALESCE(merged_at, excluded.merged_at)`,
  branches: `INSERT INTO branches (branch_ref, repo, name, base, created_at, deleted_at)
        VALUES (@branchRef, @repo, @name, @base, @createdAt, @deletedAt)
        ON CONFLICT (branch_ref) DO UPDATE SET
          base = COALESCE(base, excluded.base),
          created_at = COALESCE(created_at, excluded.created_at),
          deleted_at = COALESCE(deleted_at, excluded.deleted_at)`,
  files: `INSERT INTO files (file_ref, repo, path) VALUES (@fileRef, @repo, @path)
        ON CONFLICT (file_ref) DO NOTHING`,
  tasks: `INSERT INTO tasks (task_ref, initiative, title, status)
        VALUES (@taskRef, @initiative, @title, @status)
        ON CONFLICT (task_ref) DO UPDATE SET
          initiative = COALESCE(initiative, excluded.initiative),
          title = COALESCE(title, excluded.title), status = COALESCE(status, excluded.status)`,
  artifacts: `INSERT INTO artifacts (artifact_ref, kind, title, url, path, created_at)
        VALUES (@artifactRef, @kind, @title, @url, @path, @createdAt)
        ON CONFLICT (artifact_ref) DO NOTHING`,
};

/** `gh pr merge <n>` only yields a number, so match on number + repo suffix. */
const MARK_PR_MERGED = `
  UPDATE prs SET state = 'merged', merged_at = COALESCE(merged_at, @mergedAt)
  WHERE number = @number AND (@repoHint IS NULL OR repo LIKE '%/' || @repoHint)`;

/**
 * Every table `applyExtractResult` writes, in reverse dependency order. Each is
 * fully derivable from the JSONL plus the `transcripts` watermark, which is
 * what makes "drop and re-derive" a safe rebuild strategy.
 */
const DERIVED_TABLES = [
  'searchable_spans',
  'edges',
  'turns',
  'permission_phases',
  'human_edits',
  'subagents',
  'session_model_usage',
  'sessions',
  'facts',
  'prs',
  'branches',
  'files',
  'tasks',
  'artifacts',
];

/**
 * Clear every derived row and rewind all watermarks, so the next pass rebuilds
 * the index from byte 0.
 *
 * A full rebuild cannot just rewind the watermarks: the accumulating upserts
 * (`turn_count`, token buckets) would add a second copy of counts that the
 * append-only tables' unique indices silently discard.
 */
export function resetIndex(db: SessionIndexDb): void {
  db.transaction(() => {
    for (const table of DERIVED_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    // A contentless FTS5 table cannot delete a row without re-supplying its
    // original text, so `DELETE FROM searchable_spans` leaves `spans_fts` rows
    // behind. `'delete-all'` is the only command that clears them — this is the
    // one place orphaned FTS rows are collected.
    db.prepare(`INSERT INTO spans_fts(spans_fts) VALUES('delete-all')`).run();
    db.prepare('UPDATE transcripts SET last_byte_offset = 0, prefix_hash = NULL').run();
  })();
}

export function applyExtractResult(
  db: SessionIndexDb,
  transcriptId: number,
  result: ExtractResult,
): void {
  db.transaction(() => {
    applyFacts(db, transcriptId, result);
    applySessions(db, transcriptId, result);
    applyAssets(db, result);
    applyPhases(db, transcriptId, result);
    applyLinkedRows(db, transcriptId, result);
  })();
}

/** Facts carry a per-transcript `seq` continuing from whatever is stored. */
function applyFacts(db: SessionIndexDb, transcriptId: number, result: ExtractResult): void {
  const nextSeq = db
    .prepare<
      [number],
      { next: number }
    >('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM facts WHERE transcript_id = ?')
    .get(transcriptId);
  const insert = db.prepare(INSERT_FACT);
  let seq = nextSeq?.next ?? 0;
  for (const fact of result.facts) insert.run({ ...fact, transcriptId, seq: seq++ });
}

function applySessions(db: SessionIndexDb, transcriptId: number, result: ExtractResult): void {
  const upsertSession = db.prepare(UPSERT_SESSION);
  for (const session of result.sessions) upsertSession.run({ ...session, transcriptId });
  const upsertUsage = db.prepare(UPSERT_USAGE);
  for (const usage of result.modelUsage) upsertUsage.run(usage);
}

function applyAssets(db: SessionIndexDb, result: ExtractResult): void {
  for (const [kind, sql] of Object.entries(ASSET_UPSERTS)) {
    const rows = result[kind as keyof ExtractResult] as Record<string, unknown>[];
    const statement = db.prepare(sql);
    for (const row of rows) statement.run(row);
  }
  const markMerged = db.prepare(MARK_PR_MERGED);
  for (const merge of result.prMerges) markMerged.run(merge);
}

/**
 * Bi-temporal phase collapse: a candidate whose `to_mode` already matches the
 * session's open phase is a no-op, otherwise the open phase is closed at the
 * new phase's `t_valid` and a replacement row is inserted. Doing the collapse
 * here rather than in the extractor is what keeps a chunk boundary landing
 * mid-run from fabricating an extra phase.
 */
function applyPhases(db: SessionIndexDb, transcriptId: number, result: ExtractResult): void {
  const current = db.prepare<[string, string], { phase_id: number; to_mode: string }>(
    'SELECT phase_id, to_mode FROM permission_phases' +
      ' WHERE session_id = ? AND trigger = ? AND t_invalid IS NULL ORDER BY phase_id DESC LIMIT 1',
  );
  const close = db.prepare('UPDATE permission_phases SET t_invalid = ? WHERE phase_id = ?');
  const insert = db.prepare(
    'INSERT INTO permission_phases (session_id, from_mode, to_mode, trigger, t_valid, fact_id)' +
      ' VALUES (@sessionId, @fromMode, @toMode, @trigger, @tValid, @factId)',
  );

  for (const phase of result.permissionPhases) {
    const open = current.get(phase.sessionId, phase.trigger);
    if (open?.to_mode === phase.toMode) continue;
    if (open) close.run(phase.tValid, open.phase_id);
    insert.run({
      ...phase,
      fromMode: open?.to_mode ?? null,
      factId: factIdFor(db, transcriptId, phase.factByteOffset),
    });
  }
}

/** Rows whose `fact_id` the writer resolves from the extractor's byte offset. */
function applyLinkedRows(db: SessionIndexDb, transcriptId: number, result: ExtractResult): void {
  const withFactId = <T extends { factByteOffset: number | null }>(row: T) => ({
    ...row,
    factId: factIdFor(db, transcriptId, row.factByteOffset),
  });

  const upsertTurn = db.prepare(UPSERT_TURN);
  for (const turn of result.turns) upsertTurn.run(withFactId(turn));

  const insertHumanEdit = db.prepare(
    'INSERT INTO human_edits (session_id, file_path, ts, lines_added, lines_removed, fact_id)' +
      ' VALUES (@sessionId, @filePath, @ts, @linesAdded, @linesRemoved, @factId)',
  );
  for (const edit of result.humanEdits) insertHumanEdit.run(withFactId(edit));

  const upsertSubagent = db.prepare(
    'INSERT INTO subagents (agent_ref, session_id, parent_agent_ref, agent_type, label,' +
      ' started_at, fact_id) VALUES (@agentRef, @sessionId, @parentAgentRef, @agentType,' +
      ' @label, @startedAt, @factId) ON CONFLICT (agent_ref) DO NOTHING',
  );
  for (const subagent of result.subagents) upsertSubagent.run(withFactId(subagent));

  const insertEdge = db.prepare(INSERT_EDGE);
  for (const edge of result.edges) insertEdge.run(withFactId(edge));

  applySpans(db, transcriptId, result);
}

/**
 * Write the span locator and, in the same statement pair, tokenize its text
 * into `spans_fts`.
 *
 * `spans_fts` is contentless with `rowid == span_id`, so the FTS row must be
 * inserted with the rowid the locator insert just allocated — hence the
 * immediate `lastInsertRowid` use inside the caller's transaction, which keeps
 * the two aligned even across a crash. Skipping the FTS insert when the locator
 * hit `DO NOTHING` is what keeps a re-applied batch from stacking duplicate FTS
 * rows behind a single locator.
 *
 * `span.text` is dropped here: it exists only to cross the extractor -> writer
 * boundary, and nothing downstream retains it.
 */
function applySpans(db: SessionIndexDb, transcriptId: number, result: ExtractResult): void {
  const insert = db.prepare(
    'INSERT INTO searchable_spans (fact_id, field, transcript_id, byte_offset, byte_length)' +
      ' VALUES (@factId, @field, @transcriptId, @byteOffset, @byteLength)' +
      ' ON CONFLICT (fact_id, field, byte_offset) DO NOTHING',
  );
  const insertFts = db.prepare('INSERT INTO spans_fts (rowid, text) VALUES (?, ?)');
  for (const span of result.spans) {
    const factId = factIdFor(db, transcriptId, span.factByteOffset);
    if (factId === null) continue;
    const info = insert.run({ ...span, factId, transcriptId });
    if (info.changes === 1) insertFts.run(info.lastInsertRowid, span.text);
  }
}

function factIdFor(
  db: SessionIndexDb,
  transcriptId: number,
  byteOffset: number | null,
): number | null {
  if (byteOffset === null) return null;
  const row = db
    .prepare<
      [number, number],
      { fact_id: number }
    >('SELECT fact_id FROM facts WHERE transcript_id = ? AND byte_offset = ?')
    .get(transcriptId, byteOffset);
  return row?.fact_id ?? null;
}
