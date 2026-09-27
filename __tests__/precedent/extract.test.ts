/**
 * `precedent extract` and `precedent search`, end to end over a fixture
 * transcript indexed by the real miner refresh.
 *
 * The fixture asks two questions in one assistant turn and the harness writes
 * their results in the opposite order, as it does for parallel tool calls. An
 * extractor that paired results by position instead of by `tool_use_id` would
 * give the merge question the rejection and the wrap question the free text.
 */

import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractPrecedents } from '../../src/precedent/extract.js';
import { searchPrecedents } from '../../src/precedent/search.js';
import { readAllPrecedents } from '../../src/precedent/store.js';
import { openGraph } from '../../src/session-index/graph.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SESSION = 'sess-precedent';
const MERGE_Q = 'Merge PR #12 (the retrieval eval harness)?';
const WRAP_Q = 'What next?';
const FREE_TEXT = 'Hold until CI is green, then squash it';

let dir: string;
let transcriptsRoot: string;
let graphPath: string;
let cwd: string;

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: SESSION, cwd, gitBranch: 'feat/x', ...fields });
}

function ask(id: string, header: string, question: string, options: string[]): unknown {
  const input = {
    questions: [
      { header, question, multiSelect: false, options: options.map((label) => ({ label })) },
    ],
  };
  return { type: 'tool_use', id, name: 'AskUserQuestion', input };
}

function result(ts: string, id: string, content: string, isError = false): string {
  const block = { type: 'tool_result', tool_use_id: id, content, is_error: isError };
  return line({ type: 'user', timestamp: ts, message: { role: 'user', content: [block] } });
}

function fixtureTranscript(): string {
  const assistant = line({
    type: 'assistant',
    timestamp: '2026-09-20T10:00:01Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        ask('tu-merge', 'Merge #12', MERGE_Q, ['Squash-merge now (Recommended)', 'Hold']),
        ask('tu-wrap', 'Next', WRAP_Q, ['Wrap the session (Recommended)', 'Keep going']),
      ],
    },
  });
  return (
    [
      line({
        type: 'user',
        uuid: 'p1',
        timestamp: '2026-09-20T10:00:00Z',
        message: { role: 'user', content: 'go' },
      }),
      assistant,
      result(
        '2026-09-20T10:00:05Z',
        'tu-wrap',
        "The user doesn't want to proceed with this tool use.",
        true,
      ),
      result(
        '2026-09-20T10:05:00Z',
        'tu-merge',
        `The user answered: "${MERGE_Q}"="${FREE_TEXT}". Read the answers carefully.`,
      ),
    ].join('\n') + '\n'
  );
}

function registerWorktree(activeRoot: string): void {
  const artifacts = `worktrees:\n  - path: ${cwd}\n    repo: ${cwd}\n    name: main\n`;
  writeFileSync(path.join(activeRoot, 'sample-initiative', 'artifacts.yml'), artifacts, 'utf8');
}

function writeNote(activeRoot: string, file: string, frontmatter: string, body: string): void {
  const notes = path.join(activeRoot, 'sample-initiative', 'sources', 'notes');
  mkdirSync(notes, { recursive: true });
  writeFileSync(path.join(notes, file), `---\n${frontmatter}\n---\n${body}\n`, 'utf8');
}

function writeQueue(file: string): void {
  const db = new Database(file);
  db.exec(
    'CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)',
  );
  const insert = db.prepare(
    'INSERT INTO events (ts, kind, actor, target, msg_id, ref, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run(
    1_790_000_000_000,
    'question',
    'cc-main',
    'human',
    'q1',
    null,
    'Restart the broker now?',
  );
  insert.run(
    1_790_000_060_000,
    'answer',
    'human',
    'cc-main',
    'a1',
    'q1',
    'Yes, restart it tonight',
  );
  db.close();
}

async function indexFixture(): Promise<void> {
  const graph = openGraph(graphPath);
  try {
    await runRefresh({ graph, root: transcriptsRoot, skipWorkspace: true, skipPrOutcomes: true });
  } finally {
    graph.db.close();
  }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-precedent-'));
  cwd = path.join(dir, 'repo');
  mkdirSync(cwd, { recursive: true });
  transcriptsRoot = path.join(dir, 'projects');
  mkdirSync(path.join(transcriptsRoot, 'demo'), { recursive: true });
  writeFileSync(
    path.join(transcriptsRoot, 'demo', `${SESSION}.jsonl`),
    fixtureTranscript(),
    'utf8',
  );
  graphPath = path.join(dir, 'graph.sqlite3');
  await indexFixture();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(activeRoot: string) {
  return extractPrecedents({ activeRoot, graphPath, eventsDbPath: path.join(dir, 'events.db') });
}

describe('precedent extract', () => {
  it('pairs each answer with its own question when results arrive out of order', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);

      await run(activeRoot);

      const { rows } = await readAllPrecedents(activeRoot);
      const merge = rows.find((r) => r.question === MERGE_Q);
      const wrap = rows.find((r) => r.question === WRAP_Q);
      expect(merge).toMatchObject({
        answer: FREE_TEXT,
        pick_type: 'free_text',
        free_text: FREE_TEXT,
        recommended: 'Squash-merge now (Recommended)',
        class: 'merge_gate',
        initiative: 'sample-initiative',
        session_id: SESSION,
        tool_use_id: 'tu-merge',
      });
      expect(wrap).toMatchObject({ answer: null, pick_type: 'rejected', class: 'session_control' });
    });
  });

  it('writes only inside the active root and nothing new on a second run', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);

      const first = await run(activeRoot);
      const file = path.join(activeRoot, 'sample-initiative', 'sources', 'precedents.jsonl');
      const before = readFileSync(file, 'utf8');
      const second = await run(activeRoot);

      expect(first.files).toEqual([file]);
      expect(first.written.transcript).toBe(2);
      expect(second).toMatchObject({
        alreadyIndexed: 2,
        written: { transcript: 0, note: 0, queue: 0 },
      });
      expect(readFileSync(file, 'utf8')).toBe(before);
    });
  });

  it('files a session no initiative claims under the root-level file', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const summary = await run(activeRoot);

      expect(summary.files).toEqual([path.join(activeRoot, '.precedents.jsonl')]);
    });
  });

  it('ingests decision notes, feedback imports and queue answers, and skips other imports', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeNote(
        activeRoot,
        '2026-09-01-keep-it-private.md',
        "kind: decision\ntitle: Keep relay private\ncreated: '2026-09-01'",
        'Public is the human call.',
      );
      writeNote(
        activeRoot,
        '2026-09-02-no-wrap.md',
        "kind: fyi\ntitle: Do not offer to wrap\ncreated: '2026-09-02'\ntags:\n  - memory-import\n  - feedback",
        'Keep going while work exists.',
      );
      writeNote(
        activeRoot,
        '2026-09-03-proj.md',
        "kind: fyi\ntitle: Project fact\ncreated: '2026-09-03'\ntags:\n  - memory-import\n  - project",
        'Not a precedent.',
      );
      writeQueue(path.join(dir, 'events.db'));

      const summary = await run(activeRoot);

      const { rows } = await readAllPrecedents(activeRoot);
      expect(summary.written).toMatchObject({ note: 2, queue: 1 });
      expect(rows.map((r) => r.question)).not.toContain('Project fact');
      expect(rows.find((r) => r.source === 'queue')).toMatchObject({
        question: 'Restart the broker now?',
        answer: 'Yes, restart it tonight',
      });
    });
  });
});

describe('precedent search', () => {
  it('ranks the matching precedent first and filters by class', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);
      await run(activeRoot);
      const { rows } = await readAllPrecedents(activeRoot);

      const hits = await searchPrecedents(rows, 'should I merge the PR');
      const tasteOnly = await searchPrecedents(rows, 'should I merge the PR', {
        class: 'visual_taste',
      });

      expect(hits[0].row.tool_use_id).toBe('tu-merge');
      expect(tasteOnly).toEqual([]);
    });
  });
});
