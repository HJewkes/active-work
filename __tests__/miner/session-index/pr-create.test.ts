/**
 * AW-104: `prs.title` and `branches.base`, both sourced from `gh pr create`.
 *
 * The line shapes here were copied from real records in `~/.claude/projects`,
 * not invented. That matters more than usual: AW-106's writer was covered by a
 * green test asserting on a shape Claude Code never emits, because the
 * fixture's `line()` helper stamped fields onto every line type. So the
 * end-to-end case below builds its own lines and puts the PR number only where
 * the corpus actually puts it — `toolUseResult.gitOperation.pr`, never on the
 * command.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseGitIntent, parsePrCreateTitle } from '../../../src/miner/session-index/bash-parse.js';
import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { indexTranscript } from '../../../src/miner/session-index/quarantine.js';
import { reconcilePrCreates } from '../../../src/miner/session-index/rollup.js';
import { FIXTURE_CWD, renderTranscript } from './fixture.js';

let dir: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-pr-create-'));
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = (command: string): string | null => parseGitIntent(command)?.branchBase ?? null;
const branch = (command: string): string | null => parseGitIntent(command)?.setBranch ?? null;

describe('branch base extraction', () => {
  it('reads the start-point of git checkout -b', () => {
    expect(base('git checkout -b feat/x main')).toBe('main');
    expect(branch('git checkout -b feat/x main')).toBe('feat/x');
  });

  it('normalizes a remote start-point to the bare branch name', () => {
    expect(base('cd ~/p && git checkout -b feat/x origin/main')).toBe('main');
  });

  it('reads --base from gh pr create, in either flag order', () => {
    expect(base('gh pr create --head feat/x --base main --title "t"')).toBe('main');
    expect(base('gh pr create --base main --head feat/x --title "t"')).toBe('main');
  });

  // The three shapes that a naive capture reads as a start point. Each was the
  // dominant false positive when this was measured against the real corpus:
  // `2>&1` alone accounted for 81 of 103 captures.
  it('rejects a trailing redirect, a flag, and the next line as start-points', () => {
    expect(base('git checkout -b feat/x 2>&1 | tail -2')).toBeNull();
    expect(base('git checkout -b feat/x -q')).toBeNull();
    expect(base('git checkout -b feat/x --quiet')).toBeNull();
    expect(base('git checkout -b feat/x\ngit add -A')).toBeNull();
  });

  it('never takes a base from a different command than the one naming the branch', () => {
    const command = 'git checkout -b feat/x && gh pr create --head feat/y --base main';
    expect(branch(command)).toBe('feat/x');
    expect(base(command)).toBeNull();
  });

  it('ignores a start-point that came out of a heredoc body', () => {
    expect(base("cat <<'PY'\ngit checkout -b feat/x main\nPY")).toBeNull();
  });

  it('leaves base null for a plain branch sighting', () => {
    expect(base('git checkout -b feat/x')).toBeNull();
    expect(base('git checkout main')).toBeNull();
  });
});

describe('parsePrCreateTitle', () => {
  it('takes a single-quoted title verbatim', () => {
    expect(parsePrCreateTitle("gh pr create --title 'Add `aw resume` (AW-1)' --base main")).toBe(
      'Add `aw resume` (AW-1)',
    );
  });

  // A double-quoted title reaches the transcript still shell-escaped; storing
  // it raw put a backslash in PR #103's title that GitHub never had.
  it('unescapes what double quotes escape, and nothing else', () => {
    expect(parsePrCreateTitle('gh pr create --title "add \\`miner liveness\\` (AW-26)"')).toBe(
      'add `miner liveness` (AW-26)',
    );
    expect(parsePrCreateTitle('gh pr create --title "a \\\\ b \\"c\\""')).toBe('a \\ b "c"');
    expect(parsePrCreateTitle('gh pr create --title "keep \\d and \\w"')).toBe('keep \\d and \\w');
  });

  it('returns null when the command is not a PR creation', () => {
    expect(parsePrCreateTitle('gh pr merge 12 --squash')).toBeNull();
    expect(parsePrCreateTitle('git commit -m "x"')).toBeNull();
  });
});

const SESSION = 'sess-pr-create';
const TOOL_USE_ID = 'toolu_01create';
const COMMAND =
  'cd ~/projects/demo && gh pr create --head feat/x --base main --title "Ship \\`it\\` (AW-1)"';

/**
 * The command and its answer, shaped as the corpus shapes them: the number and
 * url live only in `toolUseResult.gitOperation.pr`, and `action` is what tells
 * a creation apart from the `edited`/`commented`/`merged` operations that share
 * the field.
 */
function prCreateLines(action = 'created'): Record<string, unknown>[] {
  return [
    {
      sessionId: SESSION,
      cwd: FIXTURE_CWD,
      gitBranch: 'main',
      type: 'assistant',
      timestamp: '2026-07-01T00:00:00Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'Bash', input: { command: COMMAND } }],
      },
    },
    {
      sessionId: SESSION,
      cwd: FIXTURE_CWD,
      gitBranch: 'main',
      type: 'user',
      timestamp: '2026-07-01T00:00:05Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ID,
            content: 'https://github.com/acme/demo/pull/42',
          },
        ],
      },
      toolUseResult: {
        stdout: 'https://github.com/acme/demo/pull/42',
        stderr: '',
        interrupted: false,
        isImage: false,
        gitOperation: {
          pr: { number: 42, url: 'https://github.com/acme/demo/pull/42', action },
        },
      },
    },
  ];
}

async function index(lines: Record<string, unknown>[], chunkBytes?: number): Promise<void> {
  const absolutePath = path.join(dir, 'session.jsonl');
  writeFileSync(absolutePath, renderTranscript(lines), 'utf8');
  await indexTranscript(db, { absolutePath, displayPath: '~/demo/session.jsonl' }, { chunkBytes });
  reconcilePrCreates(db);
}

describe('gh pr create end to end', () => {
  it('joins the command title to the number its result reports', async () => {
    await index(prCreateLines());

    expect(db.prepare('SELECT pr_ref, number, repo, title FROM prs').all()).toEqual([
      {
        pr_ref: 'pr:acme/demo#42',
        number: 42,
        repo: 'acme/demo',
        title: 'Ship `it` (AW-1)',
      },
    ]);
  });

  it('records the head branch base from the same command', async () => {
    await index(prCreateLines());

    const row = db.prepare("SELECT base FROM branches WHERE name = 'feat/x'").get();
    expect(row).toEqual({ base: 'main' });
  });

  // The two halves are separate lines, so a chunk boundary can land between
  // them. Persisting each half is what makes the join order-independent — the
  // same reason `pr_merge_observations` exists.
  it('joins the halves even when a chunk boundary separates them', async () => {
    await index(prCreateLines(), 64);

    expect(db.prepare('SELECT number, title FROM prs').all()).toEqual([
      { number: 42, title: 'Ship `it` (AW-1)' },
    ]);
  });

  it('ignores a gitOperation that is not a creation', async () => {
    await index(prCreateLines('commented'));

    expect(db.prepare('SELECT COUNT(*) AS n FROM prs').get()).toEqual({ n: 0 });
  });
});

describe('human_edits', () => {
  // AW-104 dropped these: the `edited_text_file` attachment carries no
  // before-state and a truncated after-state, so no line states a delta.
  it('has no line-count columns to leave empty', () => {
    const columns = (
      db.prepare('PRAGMA table_info("human_edits")').all() as { name: string }[]
    ).map((c) => c.name);

    expect(columns).not.toContain('lines_added');
    expect(columns).not.toContain('lines_removed');
  });
});
