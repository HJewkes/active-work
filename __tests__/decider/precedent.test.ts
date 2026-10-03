/**
 * `precedent extract` and `precedent search` over the `@titan-design/decider`
 * ledger, end to end over a fixture transcript indexed by the real miner refresh.
 *
 * The fixture asks two questions in one assistant turn and the harness writes
 * their results in the opposite order, as it does for parallel tool calls. An
 * extractor that paired results by position instead of by `tool_use_id` would
 * give the merge question the rejection and the wrap question the free text.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractPrecedents, type ExtractResult } from '../../src/decider/extract.js';
import { ledgerPath, readLedgerRows } from '../../src/decider/ledger.js';
import { searchPrecedents } from '../../src/decider/search.js';
import { openGraph } from '../../src/session-index/graph.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SESSION = 'sess-precedent';
const MERGE_Q = 'Merge PR #12 (the retrieval eval harness)?';
const WRAP_Q = 'What next?';
const FREE_TEXT = 'Hold until CI is green, then squash it';
const MERGE_QUERY = 'should I merge the PR';

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
  insert.run(1_790_000_000_000, 'question', 'cc-main', 'human', 'q1', null, 'Restart the broker?');
  insert.run(1_790_000_060_000, 'answer', 'human', 'cc-main', 'a1', 'q1', 'Yes, restart tonight');
  db.close();
}

/** v1 rows as active-work 0.21 wrote them: two questions of one call share the call's key. */
function v1Row(question: string, answer: string, overrides: Record<string, unknown> = {}) {
  return {
    key: 'transcript:sess-v1:tu-v1',
    source: 'transcript',
    asked_at: '2026-08-01T09:00:00Z',
    session_id: 'sess-v1',
    tool_use_id: 'tu-v1',
    initiative: 'sample-initiative',
    class: 'release_publish',
    header: 'Release',
    question,
    options: ['Cut 0.9.0 now (Recommended)', 'Wait a week'],
    recommended: 'Cut 0.9.0 now (Recommended)',
    answer,
    pick_type: 'recommended',
    free_text: null,
    ...overrides,
  };
}

function writeV1(activeRoot: string, file: string, rows: unknown[]): void {
  mkdirSync(path.dirname(path.join(activeRoot, file)), { recursive: true });
  const text = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  writeFileSync(path.join(activeRoot, file), text + '\n', 'utf8');
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

function writeCharter(activeRoot: string, humanOnly: string[] | null): void {
  const dirPath = path.join(activeRoot, 'claude-channels', 'sources', 'autonomy');
  mkdirSync(dirPath, { recursive: true });
  const list = humanOnly === null ? '' : `human_only_initiatives: ${JSON.stringify(humanOnly)}\n`;
  writeFileSync(path.join(dirPath, 'charter.md'), `---\n${list}---\nCharter body\n`, 'utf8');
}

function run(activeRoot: string): Promise<ExtractResult> {
  const charter = path.join(activeRoot, 'claude-channels', 'sources', 'autonomy', 'charter.md');
  if (!existsSync(charter)) writeCharter(activeRoot, []);
  return extractPrecedents({ activeRoot, graphPath, eventsDbPath: path.join(dir, 'events.db') });
}

function summary(result: ExtractResult, source: string) {
  const found = result.sources.find((s) => s.source === source);
  if (found === undefined) throw new Error(`no summary for ${source}`);
  return found;
}

async function ledgerRows(activeRoot: string) {
  return (await readLedgerRows(activeRoot)).rows;
}

describe('precedent extract', () => {
  it('pairs each answer with its own question when results arrive out of order', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);

      await run(activeRoot);

      const rows = await ledgerRows(activeRoot);
      const merge = rows.find((r) => r.question === MERGE_Q);
      const wrap = rows.find((r) => r.question === WRAP_Q);
      expect(merge).toMatchObject({
        answer: FREE_TEXT,
        outcome: 'redirect',
        recommended: 'Squash-merge now',
        category: 'merge_gate',
        initiative: 'sample-initiative',
        unclaimed: false,
        locator: { sessionId: SESSION, toolUseId: 'tu-merge' },
      });
      expect(wrap).toMatchObject({ answer: null, outcome: null, category: 'session_control' });
    });
  });

  it('writes the ledger inside the active root and nothing new on a second run', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);

      const first = await run(activeRoot);
      const second = await run(activeRoot);

      expect(first.ledger).toBe(ledgerPath(activeRoot));
      expect(existsSync(first.ledger)).toBe(true);
      expect(summary(first, 'transcript').written).toBe(2);
      expect(second.sources.reduce((n, s) => n + s.written, 0)).toBe(0);
      expect(await ledgerRows(activeRoot)).toHaveLength(2);
    });
  });

  it('ingests decision notes and feedback imports, skips other imports, and keeps queue answers unclaimed', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeNote(
        activeRoot,
        '2026-09-01-keep-it-private.md',
        "kind: decision\ntitle: Keep example-app private\ncreated: '2026-09-01'",
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

      const result = await run(activeRoot);

      const rows = await ledgerRows(activeRoot);
      expect(summary(result, 'note').written).toBe(2);
      expect(rows.map((r) => r.question)).not.toContain('Project fact');
      expect(rows.find((r) => r.source === 'queue')).toMatchObject({
        key: 'queue:2',
        unclaimed: true,
        outcome: 'redirect',
        answer: 'Yes, restart tonight',
      });
    });
  });
});

describe('v1 precedents.jsonl rows', () => {
  it('still read, in search before any extract and in the ledger after one', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeV1(activeRoot, 'sample-initiative/sources/precedents.jsonl', [
        v1Row('Cut the release now?', 'Cut 0.9.0 now (Recommended)'),
        v1Row('Publish the changelog too?', 'Wait a week', { pick_type: 'other_option' }),
        '{"not": "a row"}',
      ]);
      writeCharter(activeRoot, []);

      const before = await readLedgerRows(activeRoot);
      const result = await run(activeRoot);
      const after = await ledgerRows(activeRoot);

      expect(before.malformed).toBe(1);
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]).toMatchObject({
        v: 1,
        category: 'release_publish',
        outcome: 'accept',
        recommended: 'Cut 0.9.0 now',
        options: [{ label: 'Cut 0.9.0 now (Recommended)' }, { label: 'Wait a week' }],
      });
      expect(summary(result, 'precedents-jsonl')).toMatchObject({ written: 1, alreadyIndexed: 1 });
      expect(after.filter((r) => r.key === 'transcript:sess-v1:tu-v1')).toHaveLength(1);
    });
  });

  it('dedupe with the v2 row of the same call by key', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);
      const merge = v1Row(MERGE_Q, FREE_TEXT, {
        key: `transcript:${SESSION}:tu-merge`,
        session_id: SESSION,
        tool_use_id: 'tu-merge',
        pick_type: 'free_text',
      });
      writeV1(activeRoot, 'sample-initiative/sources/precedents.jsonl', [merge]);

      const result = await run(activeRoot);

      const keys = (await ledgerRows(activeRoot)).map((r) => r.key).sort();
      expect(summary(result, 'transcript')).toMatchObject({ written: 1, alreadyIndexed: 1 });
      expect(keys).toEqual([`transcript:${SESSION}:tu-merge`, `transcript:${SESSION}:tu-wrap`]);
    });
  });
});

describe('precedent search', () => {
  it('ranks the matching precedent first and filters by category', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);
      await run(activeRoot);
      const rows = await ledgerRows(activeRoot);

      const hits = await searchPrecedents(rows, MERGE_QUERY, { humanOnly: new Set() });
      const tasteOnly = await searchPrecedents(rows, MERGE_QUERY, {
        category: 'visual_taste',
        humanOnly: new Set(),
      });

      expect(hits[0].row.locator?.toolUseId).toBe('tu-merge');
      expect(tasteOnly).toEqual([]);
    });
  });

  it('hides rows no initiative claims unless unclaimed rows are asked for', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await run(activeRoot);
      const rows = await ledgerRows(activeRoot);

      const hidden = await searchPrecedents(rows, MERGE_QUERY, { humanOnly: new Set() });
      const shown = await searchPrecedents(rows, MERGE_QUERY, {
        humanOnly: new Set(),
        includeUnclaimed: true,
      });

      expect(summary(result, 'transcript').written).toBe(2);
      expect(rows.every((r) => r.unclaimed)).toBe(true);
      expect(hidden).toEqual([]);
      expect(shown[0].row.question).toBe(MERGE_Q);
    });
  });
});

describe('human-only initiatives', () => {
  const noteFrontmatter = "kind: decision\ntitle: Keep example-app private\ncreated: '2026-09-01'";

  it('extracts nothing from a listed initiative', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);
      writeNote(activeRoot, '2026-09-01-private.md', noteFrontmatter, 'Body.');
      writeCharter(activeRoot, ['sample-initiative']);

      const result = await run(activeRoot);

      expect(await ledgerRows(activeRoot)).toEqual([]);
      expect(summary(result, 'transcript').excluded['human-only-initiative']).toBe(2);
      expect(summary(result, 'note').excluded['human-only-initiative']).toBe(1);
    });
  });

  it.each([
    ['is missing', null],
    ['has no list', 'nolist'],
    ['has a malformed list', 'bad'],
  ])('extracts nothing and errors when the charter %s', async (_name, kind) => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);
      if (kind === 'nolist') writeCharter(activeRoot, null);
      if (kind === 'bad') {
        const dirPath = path.join(activeRoot, 'claude-channels', 'sources', 'autonomy');
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(path.join(dirPath, 'charter.md'), '---\nhuman_only_initiatives: nope\n---\n');
      }

      await expect(extractPrecedents({ activeRoot, graphPath })).rejects.toThrow(
        /human_only_initiatives/,
      );

      expect(existsSync(ledgerPath(activeRoot))).toBe(false);
    });
  });

  it('drops listed rows from search, including rows written before the listing, even with unclaimed rows included', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      registerWorktree(activeRoot);
      await run(activeRoot);
      const rows = await ledgerRows(activeRoot);

      const open = await searchPrecedents(rows, MERGE_QUERY, { humanOnly: new Set() });
      const listed = await searchPrecedents(rows, MERGE_QUERY, {
        humanOnly: new Set(['sample-initiative']),
        includeUnclaimed: true,
      });

      expect(open.length).toBeGreaterThan(0);
      expect(listed).toEqual([]);
    });
  });
});
