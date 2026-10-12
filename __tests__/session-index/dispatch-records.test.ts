/**
 * TP-513: seat dispatch logs folded into session-analytics Assignments.
 * Every log here is synthetic and lives in a temp dir.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assignmentSchema } from '@titan-design/session-analytics';
import {
  expandAgentNames,
  outcomeClass,
  readDispatchRecords,
} from '../../src/session-index/dispatch-records.js';

const OPEN = { since: null, until: null };

let logsDir: string;

beforeEach(() => {
  logsDir = mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-records-'));
});

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

function writeSeat(seat: string, lines: Array<Record<string, unknown> | string>): void {
  mkdirSync(path.join(logsDir, seat), { recursive: true });
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  writeFileSync(path.join(logsDir, seat, 'dispatch.jsonl'), `${body}\n`);
}

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: '2026-09-29T12:00:00Z',
    agent: 'impl-1',
    task: 'X-1',
    outcome: 'dispatched',
    ...over,
  };
}

describe('expandAgentNames', () => {
  it('names a bare +fix piece after the first three parts of the stem', () => {
    expect(expandAgentNames('impl-1-x-y+fix1')).toEqual(['impl-1-x-y', 'impl-1-x-fix1']);
  });

  it('keeps a piece that already has a dash as a full name', () => {
    expect(expandAgentNames('a+b-c-d')).toEqual(['a', 'b-c-d']);
  });
});

describe('outcomeClass', () => {
  it('maps done-no-pr to done and merge text to merged', () => {
    expect(outcomeClass('done-no-pr')).toBe('done');
    expect(outcomeClass('merged 2394c4d')).toBe('merged');
  });

  it('does not count a queued MERGE or lifecycle words as an outcome', () => {
    expect(outcomeClass('MERGE x; queued for owner')).toBeNull();
    expect(outcomeClass('dispatched')).toBeNull();
    expect(outcomeClass('retired')).toBeNull();
    expect(outcomeClass(null)).toBeNull();
  });
});

describe('readDispatchRecords', () => {
  it('folds a dispatched row then a merged row into one merged assignment', () => {
    writeSeat('seat-a', [
      row({ kind: 'feature', value: 'high' }),
      row({ ts: '2026-09-29T13:00:00Z', outcome: 'merged', pr: 42 }),
    ]);

    const { assignments } = readDispatchRecords(logsDir, OPEN);

    expect(assignments).toEqual([
      {
        seat: 'seat-a',
        agent: 'impl-1',
        task: 'X-1',
        kind: 'feature',
        initiative: null,
        outcome: 'merged',
        value: 'high',
        pr: '42',
        ts: '2026-09-29T13:00:00.000Z',
      },
    ]);
    expect(assignments.every((a) => assignmentSchema.safeParse(a).success)).toBe(true);
  });

  it('keeps merged when a broker retired row follows it', () => {
    writeSeat('seat-a', [
      row({ outcome: 'merged' }),
      row({ ts: '2026-09-29T14:00:00Z', outcome: 'retired' }),
    ]);

    const { assignments } = readDispatchRecords(logsDir, OPEN);

    expect(assignments.map((a) => a.outcome)).toEqual(['merged']);
  });

  it('lets a later terminal outcome replace an earlier one', () => {
    writeSeat('seat-a', [
      row({ outcome: 'parked' }),
      row({ ts: '2026-09-29T15:00:00Z', outcome: 'merged' }),
    ]);

    expect(readDispatchRecords(logsDir, OPEN).assignments.map((a) => a.outcome)).toEqual([
      'merged',
    ]);
  });

  it('records done-no-pr as done', () => {
    writeSeat('seat-a', [row({ outcome: 'done-no-pr' })]);

    expect(readDispatchRecords(logsDir, OPEN).assignments[0]!.outcome).toBe('done');
  });

  it('gives a +fix agent fix-round so the group counts one merge', () => {
    writeSeat('seat-a', [row({ agent: 'impl-1-x-y+fix1', outcome: 'merged' })]);

    const { assignments } = readDispatchRecords(logsDir, OPEN);

    expect(assignments.map((a) => [a.agent, a.outcome])).toEqual([
      ['impl-1-x-fix1', 'fix-round'],
      ['impl-1-x-y', 'merged'],
    ]);
  });

  it('skips rows before since and at until, and keeps an offset row inside the window', () => {
    writeSeat('seat-a', [
      row({ agent: 'early', ts: '2026-09-28T23:59:59.999Z' }),
      row({ agent: 'at-until', ts: '2026-09-30T00:00:00Z' }),
      row({ agent: 'offset', ts: '2026-09-29T17:00:00-0600' }),
    ]);

    const { assignments } = readDispatchRecords(logsDir, {
      since: '2026-09-29T00:00:00Z',
      until: '2026-09-30T00:00:00Z',
    });

    expect(assignments.map((a) => a.agent)).toEqual(['offset']);
  });

  it('counts a bad JSON line and an agentless row without dropping the rest', () => {
    writeSeat('seat-a', ['{not json', row({ agent: undefined }), '', row({ outcome: 'done' })]);

    const { assignments, skipped } = readDispatchRecords(logsDir, OPEN);

    expect(skipped).toEqual({ badLines: 1, noAgent: 1 });
    expect(assignments.map((a) => a.outcome)).toEqual(['done']);
  });

  it('takes the seat from the directory and sorts by seat, agent and task', () => {
    writeSeat('seat-b', [row({ agent: 'impl-2' })]);
    writeSeat('seat-a', [row({ agent: 'impl-2', task: 'X-2' }), row({ agent: 'impl-2' })]);

    const { assignments } = readDispatchRecords(logsDir, OPEN);

    expect(assignments.map((a) => [a.seat, a.task])).toEqual([
      ['seat-a', 'X-1'],
      ['seat-a', 'X-2'],
      ['seat-b', 'X-1'],
    ]);
  });

  it('returns nothing for a missing logs dir', () => {
    expect(readDispatchRecords(path.join(logsDir, 'absent'), OPEN)).toEqual({
      assignments: [],
      skipped: { badLines: 0, noAgent: 0 },
    });
  });
});
