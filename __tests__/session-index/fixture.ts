/**
 * Hand-written transcript fixtures for the AW-23 extractor tests.
 *
 * Deliberately synthetic and small: the AW-22 prototype's full fixture is the
 * operator's private `~/.claude` corpus, which CI does not have, and a
 * hand-written file makes "one line of each event type" auditable at a glance.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SESSION = 'sess-1';

/**
 * Repo attribution is resolved against the real filesystem (AW-91), so the
 * fixture's `cwd` has to be a directory that actually looks like a git working
 * tree. A `.git/config` with an `origin` remote is the whole contract — no
 * `git init` needed, which keeps the fixture hermetic and fast. The path is
 * deterministic and reused across runs rather than a fresh `mkdtemp`, so
 * repeated test runs cannot accumulate temp directories.
 */
export const FIXTURE_CWD = path.join(os.tmpdir(), 'aw-session-index-fixture-repo');

mkdirSync(path.join(FIXTURE_CWD, '.git'), { recursive: true });
writeFileSync(
  path.join(FIXTURE_CWD, '.git', 'config'),
  '[remote "origin"]\n\turl = git@github.com:acme/demo.git\n',
  'utf8',
);

const CWD = FIXTURE_CWD;

function line(fields: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: SESSION, cwd: CWD, gitBranch: 'feat/x', ...fields };
}

function userPrompt(uuid: string, ts: string, text: string): Record<string, unknown> {
  return line({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } });
}

function assistant(ts: string, content: unknown[]): Record<string, unknown> {
  return line({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
      content,
    },
  });
}

function toolUse(id: string, name: string, input: unknown): Record<string, unknown> {
  return { type: 'tool_use', id, name, input };
}

/** One line of every event type the extractor branches on. */
export const FIXTURE_LINES: Record<string, unknown>[] = [
  line({ type: 'ai-title', aiTitle: 'Demo session', timestamp: '2026-07-01T00:00:00Z' }),
  line({ type: 'last-prompt', lastPrompt: 'seed the demo', timestamp: '2026-07-01T00:00:01Z' }),
  line({ type: 'mode', mode: 'plan', timestamp: '2026-07-01T00:00:02Z' }),
  line({
    type: 'permission-mode',
    permissionMode: 'acceptEdits',
    timestamp: '2026-07-01T00:00:03Z',
  }),
  userPrompt('p1', '2026-07-01T00:00:04Z', 'please build it'),
  assistant('2026-07-01T00:00:05Z', [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'on it' },
  ]),
  assistant('2026-07-01T00:00:06Z', [
    toolUse('t1', 'Edit', { file_path: `${CWD}/src/app.ts`, old_string: 'a', new_string: 'ab' }),
  ]),
  assistant('2026-07-01T00:00:07Z', [
    toolUse('t2', 'Read', { file_path: `${CWD}/node_modules/x.js` }),
  ]),
  line({
    type: 'user',
    timestamp: '2026-07-01T00:00:08Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' }],
    },
  }),
  assistant('2026-07-01T00:00:09Z', [
    toolUse('t3', 'Agent', { description: 'do research', subagent_type: 'Explore' }),
  ]),
  assistant('2026-07-01T00:00:10Z', [toolUse('t4', 'AskUserQuestion', { questions: [] })]),
  assistant('2026-07-01T00:00:11Z', [
    toolUse('t5', 'Artifact', { description: 'a chart', file_path: 'chart.html' }),
  ]),
  assistant('2026-07-01T00:00:12Z', [
    toolUse('t6', 'Bash', {
      command: `cd ${CWD} && git checkout -b feat/y && git commit -m x`,
    }),
  ]),
  assistant('2026-07-01T00:00:13Z', [
    toolUse('t7', 'Bash', { command: 'aw task done demo AW-23' }),
  ]),
  line({
    type: 'attachment',
    timestamp: '2026-07-01T00:00:14Z',
    attachment: { type: 'edited_text_file', filename: `${CWD}/src/app.ts` },
  }),
  // Deliberately NOT built via `line()`: real `file-history-snapshot` records
  // carry no top-level `sessionId`/`cwd`/`gitBranch`/`timestamp` at all — only
  // these four keys. The extractor must fall back to the transcript's own
  // filename for the session id (see `LineHandler`'s `fallbackSessionId`).
  {
    type: 'file-history-snapshot',
    messageId: 'msg-fh-1',
    isSnapshotUpdate: false,
    snapshot: {
      messageId: 'msg-fh-1',
      timestamp: '2026-07-01T00:00:14Z',
      trackedFileBackups: {
        [`${CWD}/src/app.ts`]: {
          backupFileName: 'abc123@v1',
          version: 1,
          backupTime: '2026-07-01T00:00:14Z',
          realParentDir: `${CWD}/src`,
        },
        [`${CWD}/node_modules/x.js`]: {
          backupFileName: 'ignored@v1',
          version: 1,
          backupTime: '2026-07-01T00:00:14Z',
          realParentDir: `${CWD}/node_modules`,
        },
      },
    },
  },
  // Deliberately NOT built through `line()`: a real `pr-link` carries exactly
  // these six fields. Stamping it with the helper's `cwd`/`gitBranch` is what
  // made a dead `built_on` writer look tested for months (AW-106).
  {
    sessionId: SESSION,
    type: 'pr-link',
    timestamp: '2026-07-01T00:00:15Z',
    prNumber: 42,
    prRepository: 'acme/demo',
    prUrl: 'https://github.com/acme/demo/pull/42',
  },
  assistant('2026-07-01T00:00:16Z', [
    toolUse('t8', 'Bash', { command: 'gh pr merge 42 --squash' }),
  ]),
  line({
    type: 'frame-link',
    timestamp: '2026-07-01T00:00:17Z',
    frameUrl: 'https://frames/1',
    title: 'F',
  }),
  line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-01T00:00:18Z' }),
  userPrompt('p2', '2026-07-01T00:00:19Z', 'ship it'),
];

export function renderTranscript(lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** Byte offset just past the Nth line — a valid resume watermark. */
export function offsetAfterLine(lines: Record<string, unknown>[], count: number): number {
  return Buffer.byteLength(renderTranscript(lines.slice(0, count)), 'utf8');
}
