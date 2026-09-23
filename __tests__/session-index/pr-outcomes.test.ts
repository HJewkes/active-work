/**
 * TP-275: PR outcomes filled from the forge through `gh`, behind
 * `@titan-design/session-graph`'s `PrResolver` seam. `gh` is mocked at the
 * process boundary, so no test here ever runs the real binary.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichPrs } from '@titan-design/session-graph';
import type { CommandResult, RunCommand } from '../../src/discover/run-command.js';
import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import { ghPrResolver } from '../../src/session-index/pr-outcomes.js';
import { runRefresh } from '../../src/session-index/refresh.js';

let dir: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-pr-outcomes-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

type GhAnswer = Record<string, unknown> | Error | CommandResult;

/** A `gh` stand-in keyed by `<repo>#<number>`; records every PR it was asked about. */
function fakeGh(answers: Record<string, GhAnswer>): RunCommand & { asked: string[] } {
  const asked: string[] = [];
  const run = (_bin: string, args: string[]): Promise<CommandResult> => {
    const key = `${args[args.indexOf('--repo') + 1] ?? ''}#${args[2] ?? ''}`;
    asked.push(key);
    const answer = answers[key];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer && 'code' in answer) return Promise.resolve(answer as CommandResult);
    return Promise.resolve({ code: 0, stdout: JSON.stringify(answer ?? {}), stderr: '' });
  };
  return Object.assign(run, { asked });
}

function addPr(
  number: number,
  fields: { state?: string | null; checkedAt?: string | null; repo?: string } = {},
): void {
  const repo = fields.repo ?? 'acme/demo';
  graph.db
    .prepare(
      'INSERT INTO pr (pr_ref, repo, number, state, outcome_checked_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(`pr:${repo}#${number}`, repo, number, fields.state ?? null, fields.checkedAt ?? null);
}

const rowFor = (number: number): Record<string, unknown> | undefined =>
  graph.db
    .prepare(
      'SELECT state, merged_at, closed_at, review_rounds, outcome_checked_at FROM pr WHERE number = ?',
    )
    .get(number) as Record<string, unknown> | undefined;

const pr = (fields: Record<string, unknown>): Record<string, unknown> => ({
  state: 'OPEN',
  mergedAt: null,
  closedAt: null,
  reviews: [],
  commits: [],
  ...fields,
});

describe('the gh PR resolver', () => {
  it('fills merged and closed state', async () => {
    addPr(1);
    addPr(2);
    const gh = fakeGh({
      'acme/demo#1': pr({
        state: 'MERGED',
        mergedAt: '2026-09-20T10:00:00Z',
        closedAt: '2026-09-20T10:00:00Z',
      }),
      'acme/demo#2': pr({ state: 'CLOSED', closedAt: '2026-09-21T09:00:00Z' }),
    });

    const result = await enrichPrs(graph, ghPrResolver(graph, { run: gh }));

    expect(result).toMatchObject({ requested: 2, applied: 2, failed: false });
    expect(rowFor(1)).toMatchObject({
      state: 'merged',
      merged_at: '2026-09-20T10:00:00Z',
      closed_at: '2026-09-20T10:00:00Z',
    });
    expect(rowFor(2)).toMatchObject({
      state: 'closed',
      merged_at: null,
      closed_at: '2026-09-21T09:00:00Z',
    });
    expect(rowFor(2)?.outcome_checked_at).toEqual(expect.any(String));
  });

  it('counts review rounds by the agreed rule', async () => {
    addPr(3);
    const review = (state: string, submittedAt: string): Record<string, string> => ({
      state,
      submittedAt,
    });
    const gh = fakeGh({
      'acme/demo#3': pr({
        reviews: [
          review('CHANGES_REQUESTED', '2026-09-20T01:00:00Z'),
          review('COMMENTED', '2026-09-20T01:30:00Z'),
          review('CHANGES_REQUESTED', '2026-09-20T03:00:00Z'),
          review('APPROVED', '2026-09-20T05:00:00Z'),
          // No commit follows this one, so it is not a round yet.
          review('CHANGES_REQUESTED', '2026-09-20T06:00:00Z'),
        ],
        commits: [
          { committedDate: '2026-09-20T00:00:00Z' },
          { committedDate: '2026-09-20T02:00:00Z' },
          { committedDate: '2026-09-20T04:00:00Z' },
        ],
      }),
    });

    await enrichPrs(graph, ghPrResolver(graph, { run: gh }));

    expect(rowFor(3)).toMatchObject({ review_rounds: 2 });
  });

  it('asks only for open PRs and PRs never checked, at most 50 per pass', async () => {
    const checked = '2026-09-22T00:00:00Z';
    addPr(1, { state: 'merged', checkedAt: checked });
    addPr(2, { state: 'closed', checkedAt: checked });
    addPr(3, { state: 'open', checkedAt: checked });
    for (let n = 100; n < 160; n++) addPr(n);
    const gh = fakeGh({});

    await enrichPrs(graph, ghPrResolver(graph, { run: gh }));

    expect(gh.asked).toHaveLength(50);
    expect(gh.asked).not.toContain('acme/demo#1');
    expect(gh.asked).not.toContain('acme/demo#2');
    // Never-checked PRs go before a PR checked on an earlier pass.
    expect(gh.asked).not.toContain('acme/demo#3');

    gh.asked.length = 0;
    await enrichPrs(graph, ghPrResolver(graph, { run: gh }));

    expect(gh.asked).toHaveLength(11);
    expect(gh.asked).toContain('acme/demo#3');
  });

  it('a gh failure is reported in errors and the pass succeeds', async () => {
    const root = path.join(dir, 'projects');
    mkdirSync(root, { recursive: true });
    addPr(7);
    addPr(8);
    addPr(9);
    const gh = fakeGh({
      'acme/demo#7': {
        code: 1,
        stdout: '',
        stderr: 'GraphQL: Could not resolve to a PullRequest\n',
      },
      'acme/demo#8': Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
      'acme/demo#9': pr({ state: 'CLOSED', closedAt: '2026-09-21T09:00:00Z' }),
    });

    const summary = await runRefresh({ graph, root, skipWorkspace: true, runGh: gh });

    expect(summary.errors).toEqual([
      'prs: acme/demo#7: GraphQL: Could not resolve to a PullRequest',
      'prs: acme/demo#8: spawn gh ENOENT',
    ]);
    expect(rowFor(7)).toMatchObject({ outcome_checked_at: null });
    expect(rowFor(8)).toMatchObject({ outcome_checked_at: null });
    expect(rowFor(9)).toMatchObject({ state: 'closed' });
  });
});
