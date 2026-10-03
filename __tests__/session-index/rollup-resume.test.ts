import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SessionGraphPackage from '@titan-design/session-graph';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

const cut = vi.hoisted(() => ({ armed: false }));

// Index the first transcript, advancing its watermark, then die before the rollup.
vi.mock('@titan-design/session-graph', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionGraphPackage>();
  return {
    ...actual,
    refreshCorpus: async (...args: Parameters<typeof actual.refreshCorpus>) => {
      if (!cut.armed) return actual.refreshCorpus(...args);
      const [graph, transcripts] = args;
      const first = transcripts[0];
      if (first) await actual.indexTranscript(graph, first);
      throw new Error('pass killed between index and rollup');
    },
  };
});

let dir: string;
let root: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-rollup-resume-'));
  root = path.join(dir, 'projects');
  mkdirSync(path.join(root, 'demo'), { recursive: true });
  writeFileSync(path.join(root, 'demo', 'a.jsonl'), renderTranscript(FIXTURE_LINES), 'utf8');
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  cut.armed = false;
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const unfinishedTurns = (): number =>
  (graph.db.prepare('SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NULL').get() as { n: number })
    .n;

const pass = (): ReturnType<typeof runRefresh> =>
  runRefresh({ graph, root, skipPrOutcomes: true, skipWorkspace: true, taskRoot: dir });

describe('a full pass cut between index and rollup', () => {
  it('leaves no turn without ended_at after the next pass', async () => {
    cut.armed = true;
    await expect(pass()).rejects.toThrow('pass killed');
    expect(unfinishedTurns()).toBeGreaterThan(0);
    cut.armed = false;

    const next = await pass();

    expect(next.unchanged).toBe(1);
    expect(next.turnsRolledUp).toBeGreaterThan(0);
    expect(unfinishedTurns()).toBe(0);
  });

  it('rolls up nothing extra once every turn has ended_at', async () => {
    await pass();

    const next = await pass();

    expect(next.unchanged).toBe(1);
    expect(next.turnsRolledUp).toBe(0);
  });
});
