-- AW-23 session-signal index. Single versioned schema file, applied
-- idempotently and tracked via `PRAGMA user_version` (see db.ts).
--
-- Locator shape throughout this subsystem is
-- `(transcript_id, byte_offset, byte_length)` — a pointer back into the raw
-- `~/.claude/projects/**/*.jsonl`. This is NOT the same shape as AW-28's
-- in-memory `Locator` tuple in src/schemas/template.ts, which indexes into an
-- in-process transcript array by position. Do not conflate the two.

-- ── Watermark (incremental re-index) ────────────────────────────────────────
-- `prefix_hash` is sha256 over bytes [0, last_byte_offset): a mismatch on
-- resume means the file was rewritten rather than appended to, forcing a full
-- re-index from byte 0. `file_size`/`file_mtime`/`content_hash` make "source
-- JSONL gone or altered" a detectable, actionable state rather than silent
-- locator rot (§CASS source-durability gap).
CREATE TABLE IF NOT EXISTS transcripts (
  transcript_id     INTEGER PRIMARY KEY,
  path              TEXT NOT NULL UNIQUE,
  last_byte_offset  INTEGER NOT NULL DEFAULT 0,
  prefix_hash       TEXT,
  last_indexed_at   TEXT,
  file_size         INTEGER,
  file_mtime        TEXT,
  content_hash      TEXT,
  status            TEXT NOT NULL DEFAULT 'ok',  -- ok|missing|hash_mismatch|quarantined
  quarantine_reason TEXT
);

-- ── Facts — raw event log (byte-offset provenance, OTEL ids) ────────────────
-- UNIQUE(transcript_id, byte_offset) is what makes a re-applied extraction
-- batch a no-op instead of a duplicate-row generator.
CREATE TABLE IF NOT EXISTS facts (
  fact_id         INTEGER PRIMARY KEY,
  transcript_id   INTEGER NOT NULL REFERENCES transcripts(transcript_id),
  byte_offset     INTEGER NOT NULL,
  byte_length     INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  ts              TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  session_id      TEXT NOT NULL,
  prompt_id       TEXT,
  tool_use_id     TEXT,
  agent_id        TEXT,
  parent_agent_id TEXT,
  workflow_run_id TEXT,
  t_indexed       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (transcript_id, byte_offset)
);
CREATE INDEX IF NOT EXISTS idx_facts_session_ts ON facts(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_facts_prompt ON facts(prompt_id);
CREATE INDEX IF NOT EXISTS idx_facts_tool_use ON facts(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_facts_agent ON facts(agent_id);

-- ── Sessions + per-model token buckets ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  transcript_id INTEGER REFERENCES transcripts(transcript_id),
  started_at    TEXT,
  ended_at      TEXT,
  start_type    TEXT,
  cwd           TEXT,
  git_branch    TEXT,
  ai_title      TEXT,
  seed_prompt   TEXT,
  cli_version   TEXT,
  turn_count    INTEGER NOT NULL DEFAULT 0,
  commit_count  INTEGER NOT NULL DEFAULT 0,
  push_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

-- Token counts are the source of truth; `cost_usd` is an optional
-- denormalized cache. Dollar figures come from joining `model_pricing` at
-- rollup time so price changes apply retroactively without re-ingesting.
CREATE TABLE IF NOT EXISTS session_model_usage (
  session_id            TEXT NOT NULL REFERENCES sessions(session_id),
  model                 TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL,
  request_count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, model)
);
CREATE INDEX IF NOT EXISTS idx_smu_model ON session_model_usage(model);

CREATE TABLE IF NOT EXISTS model_pricing (
  pricing_id          INTEGER PRIMARY KEY,
  model_pattern       TEXT NOT NULL,
  effective_date      TEXT NOT NULL,
  input_rate          REAL NOT NULL,
  output_rate         REAL NOT NULL,
  cache_read_rate     REAL NOT NULL DEFAULT 0,
  cache_creation_rate REAL NOT NULL DEFAULT 0,
  thinking_rate       REAL NOT NULL DEFAULT 0,
  UNIQUE (model_pattern, effective_date)
);

-- ── Turns — the prompt thread as a first-class episode ──────────────────────
CREATE TABLE IF NOT EXISTS turns (
  prompt_id       TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  turn_index      INTEGER NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_ms     INTEGER,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  thinking_ms     INTEGER NOT NULL DEFAULT 0,
  fact_id_start   INTEGER REFERENCES facts(fact_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_index);

-- ── Permission/mode spans (bi-temporal interval) + human edits ──────────────
CREATE TABLE IF NOT EXISTS permission_phases (
  phase_id   INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  from_mode  TEXT,
  to_mode    TEXT NOT NULL,
  trigger    TEXT,
  t_valid    TEXT NOT NULL,
  t_invalid  TEXT,  -- NULL = still open
  fact_id    INTEGER REFERENCES facts(fact_id)
);
CREATE INDEX IF NOT EXISTS idx_permphases_session ON permission_phases(session_id, t_valid);

CREATE TABLE IF NOT EXISTS human_edits (
  edit_id       INTEGER PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(session_id),
  file_path     TEXT NOT NULL,
  ts            TEXT NOT NULL,
  lines_added   INTEGER,
  lines_removed INTEGER,
  fact_id       INTEGER REFERENCES facts(fact_id)
);
CREATE INDEX IF NOT EXISTS idx_human_edits_session ON human_edits(session_id);
CREATE INDEX IF NOT EXISTS idx_human_edits_file ON human_edits(file_path);

-- ── Per-asset tables (stable `*_ref` = join key into edges) ─────────────────
-- Refs: session:<id>, file:<repo>/<path>, pr:<repo>#<n>, branch:<repo>/<name>,
-- task:AW-23, agent:<toolUseId>, artifact:<uuid>.
CREATE TABLE IF NOT EXISTS prs (
  pr_ref TEXT PRIMARY KEY, number INTEGER, repo TEXT, title TEXT, state TEXT,
  url TEXT, merged_at TEXT
);
CREATE TABLE IF NOT EXISTS branches (
  branch_ref TEXT PRIMARY KEY, repo TEXT, name TEXT, base TEXT,
  created_at TEXT, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS files (
  file_ref TEXT PRIMARY KEY, repo TEXT, path TEXT NOT NULL
);
-- A `gh pr merge <n>` sighting, kept as an observation rather than applied
-- straight to `prs`. The command only yields a bare number, so it can only be
-- matched against a `pr_ref` that a `pr-link` event has already produced — and
-- nothing guarantees the link is indexed first. Persisting the sighting lets
-- `reconcilePrMerges` fold it in at the end of every pass, which makes the
-- result independent of the order transcripts and chunks happen to arrive in.
CREATE TABLE IF NOT EXISTS pr_merge_observations (
  number    INTEGER NOT NULL,
  repo_hint TEXT,
  merged_at TEXT NOT NULL,
  PRIMARY KEY (number, repo_hint, merged_at)
);

CREATE TABLE IF NOT EXISTS tasks (
  task_ref TEXT PRIMARY KEY, initiative TEXT, title TEXT, status TEXT,
  created_at TEXT, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS subagents (
  agent_ref        TEXT PRIMARY KEY,
  session_id       TEXT REFERENCES sessions(session_id),
  parent_agent_ref TEXT REFERENCES subagents(agent_ref),
  agent_type       TEXT,
  label            TEXT,
  started_at       TEXT,
  ended_at         TEXT,
  fact_id          INTEGER REFERENCES facts(fact_id)
);
CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_ref TEXT PRIMARY KEY, kind TEXT, title TEXT, url TEXT,
  path TEXT, created_at TEXT
);

-- ── Edges — generic, bi-temporal relation table ─────────────────────────────
-- New relation type = an INSERT, no migration. Corrections set `t_expired` and
-- insert a replacement row (invalidate-not-delete) so history stays auditable
-- while the partial indices keep live-state lookups cheap. Relation names are
-- documented in src/schemas/session-index-relations.ts, deliberately not as a
-- DB CHECK constraint.
CREATE TABLE IF NOT EXISTS edges (
  edge_id    INTEGER PRIMARY KEY,
  source_ref TEXT NOT NULL,
  relation   TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  t_valid    TEXT NOT NULL,
  t_invalid  TEXT,
  t_created  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  t_expired  TEXT,
  fact_id    INTEGER REFERENCES facts(fact_id),
  confidence REAL NOT NULL DEFAULT 1.0
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_ref, relation) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_ref, relation) WHERE t_expired IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_current ON edges(source_ref, relation, target_ref) WHERE t_expired IS NULL;

-- ── FTS5 — contentless, rebuildable ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS searchable_spans (
  span_id       INTEGER PRIMARY KEY,
  fact_id       INTEGER NOT NULL REFERENCES facts(fact_id),
  field         TEXT NOT NULL,  -- prompt|assistant_response|tool_input|tool_result
  transcript_id INTEGER NOT NULL REFERENCES transcripts(transcript_id),
  byte_offset   INTEGER NOT NULL,
  byte_length   INTEGER NOT NULL,
  UNIQUE (fact_id, field, byte_offset)
);
CREATE INDEX IF NOT EXISTS idx_spans_fact ON searchable_spans(fact_id);

-- Genuinely contentless (content=''), NOT external-content: `searchable_spans`
-- stores only a locator, the real text lives in the raw JSONL on disk, so there
-- is no content table for `content_rowid` to point at. rowid == span_id.
--
-- MANDATORY QUERY RULE: never trust a raw `spans_fts` rowid. Every read must
-- join through
--   `spans_fts JOIN searchable_spans ON spans_fts.rowid = searchable_spans.span_id`
-- A contentless FTS5 table cannot delete a row without its original text, so
-- per-transcript purges (rotation) and `resetIndex` both strand FTS rows whose
-- `searchable_spans` row is gone. The join makes those orphans invisible;
-- `refresh --full` (which runs `VALUES('delete-all')`) is the only thing that
-- physically removes them, and `miner status` warns once the orphan ratio
-- passes 20%.
--
-- Caveat for any future Cloudflare D1 backup path: `wrangler d1 export` fails
-- for the WHOLE database if any FTS5 virtual table exists (confirmed on a
-- sibling project). Export tooling would have to DROP this table, export, then
-- rebuild it (`INSERT INTO spans_fts(spans_fts) VALUES('rebuild')`) around
-- every export cycle. Forward-looking documentation only.
CREATE VIRTUAL TABLE IF NOT EXISTS spans_fts USING fts5(text, content='');
