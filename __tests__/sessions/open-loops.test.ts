import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  deriveOpenLoops,
  deriveOpenLoopsFrom,
  findDanglingResolves,
  findSessionIssues,
  loadSessionsFromDir,
} from '../../src/sessions/open-loops.js';
import type { Task } from '../../src/schemas/task.js';

const NOW = new Date('2026-07-28T00:00:00Z');

let initiativeDir: string;

interface SessionInput {
  session_id: string;
  ended: string;
  /** Filename stem; defaults to `<date>-<session_id>`. */
  file?: string;
  track?: 'canonical' | 'sidecar' | 'adhoc';
  next_steps?: unknown[];
  resolves?: unknown[];
}

/** Write a session file and return its stem — the identity half of a loop ref. */
async function writeSession(input: SessionInput): Promise<string> {
  const frontmatter = {
    session_id: input.session_id,
    started: input.ended,
    ended: input.ended,
    track: input.track ?? 'canonical',
    next_steps: input.next_steps ?? [],
    resolves: input.resolves ?? [],
  };
  const stem = input.file ?? `${input.ended.slice(0, 10)}-${input.session_id}`;
  await fs.writeFile(
    path.join(initiativeDir, 'sessions', `${stem}.md`),
    `---\n${YAML.stringify(frontmatter)}---\n\nnarrative\n`,
    'utf8',
  );
  return stem;
}

function task(id: string, status: 'open' | 'done'): Task {
  return {
    id,
    title: id,
    priority: 1,
    status,
    created: '2026-07-01',
    updated: '2026-07-01',
    done_at: status === 'done' ? '2026-07-02' : null,
  };
}

beforeEach(async () => {
  initiativeDir = mkdtempSync(path.join(tmpdir(), 'aw-loops-'));
  await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(initiativeDir, { recursive: true, force: true });
});

describe('deriveOpenLoops', () => {
  it('returns nothing when the initiative has no sessions directory', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'aw-loops-empty-'));
    try {
      expect(await deriveOpenLoops(empty, { now: NOW })).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('surfaces unresolved loops oldest first with whole-day ages', async () => {
    const newer = await writeSession({
      session_id: '731ae3d3',
      ended: '2026-07-16T12:00:00Z',
      next_steps: [{ id: 'n1', text: 'Wire cost rollup', kind: 'prose' }],
    });
    const older = await writeSession({
      session_id: '8f2c1a44',
      ended: '2026-07-07T12:00:00Z',
      next_steps: [{ id: 'n1', text: 'SQLite index', kind: 'task', ref: 'AW-23' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });

    expect(loops.map((l) => l.ref)).toEqual([`${older}#n1`, `${newer}#n1`]);
    expect(loops[0]).toMatchObject({
      text: 'SQLite index',
      kind: 'task',
      targetRef: 'AW-23',
      sessionFile: older,
      sessionId: '8f2c1a44',
      openedAt: '2026-07-07T12:00:00Z',
      ageDays: 20,
    });
    expect(loops[1]?.targetRef).toBeUndefined();
    expect(loops[1]?.ageDays).toBe(11);
  });

  it('keys loops by filename, so files sharing a session_id stay distinct', async () => {
    // `session.record` appends -1, -2 when one session records repeatedly, so
    // several files legitimately carry the same session_id.
    const first = await writeSession({
      session_id: 'dupe',
      file: '2026-07-01-1000-dupe',
      ended: '2026-07-01T10:00:00Z',
      next_steps: [{ id: 'n1', text: 'from the first file', kind: 'prose' }],
    });
    const second = await writeSession({
      session_id: 'dupe',
      file: '2026-07-01-1000-dupe-1',
      ended: '2026-07-01T11:00:00Z',
      next_steps: [{ id: 'n1', text: 'from the second file', kind: 'prose' }],
    });
    await writeSession({
      session_id: 'later',
      ended: '2026-07-05T00:00:00Z',
      resolves: [{ ref: `${first}#n1`, outcome: 'done' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${second}#n1`]);
    expect(loops[0]?.text).toBe('from the second file');
    expect(loops[0]?.sessionId).toBe('dupe');
  });

  it('closes a loop resolved by a later session', async () => {
    const opener = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [
        { id: 'n1', text: 'closed', kind: 'prose' },
        { id: 'n2', text: 'still open', kind: 'prose' },
      ],
    });
    await writeSession({
      session_id: 'bbb',
      ended: '2026-07-05T00:00:00Z',
      resolves: [{ ref: `${opener}#n1`, outcome: 'done' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${opener}#n2`]);
  });

  it('closes a loop abandoned by a later session', async () => {
    const opener = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'lapsed window', kind: 'prose' }],
    });
    await writeSession({
      session_id: 'bbb',
      ended: '2026-07-05T00:00:00Z',
      resolves: [{ ref: `${opener}#n1`, outcome: 'abandoned', note: 'window lapsed' }],
    });

    expect(await deriveOpenLoops(initiativeDir, { now: NOW })).toEqual([]);
  });

  it('ignores a resolve pointing forward in time', async () => {
    await writeSession({
      session_id: 'early',
      ended: '2026-07-01T00:00:00Z',
      resolves: [{ ref: '2026-07-10-late#n1', outcome: 'done' }],
    });
    const late = await writeSession({
      session_id: 'late',
      ended: '2026-07-10T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'opened after the resolve', kind: 'prose' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${late}#n1`]);
  });

  it('ignores track: ad-hoc and sidecar sessions open real loops', async () => {
    const adhoc = await writeSession({
      session_id: 'adh',
      ended: '2026-07-02T00:00:00Z',
      track: 'adhoc',
      next_steps: [{ id: 'n1', text: 'from ad-hoc work', kind: 'prose' }],
    });
    const sidecar = await writeSession({
      session_id: 'sid',
      ended: '2026-07-03T00:00:00Z',
      track: 'sidecar',
      next_steps: [{ id: 'n1', text: 'from a folded hit', kind: 'prose' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${adhoc}#n1`, `${sidecar}#n1`]);
  });

  it('auto-resolves a task loop whose task is done, but only when tasks are supplied', async () => {
    const opener = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [
        { id: 'n1', text: 'done task', kind: 'task', ref: 'AW-24' },
        { id: 'n2', text: 'open task', kind: 'task', ref: 'AW-25' },
        { id: 'n3', text: 'untyped mention of AW-24', kind: 'prose', ref: 'AW-24' },
      ],
    });

    const withoutTasks = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(withoutTasks).toHaveLength(3);

    const withTasks = await deriveOpenLoops(initiativeDir, {
      now: NOW,
      tasks: [task('AW-24', 'done'), task('AW-25', 'open')],
    });
    expect(withTasks.map((l) => l.ref)).toEqual([`${opener}#n2`, `${opener}#n3`]);
  });

  it('resurrects an auto-resolved loop, with its original age, when the task reopens', async () => {
    const opener = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'ship the index', kind: 'task', ref: 'AW-24' }],
    });

    const whileDone = await deriveOpenLoops(initiativeDir, {
      now: NOW,
      tasks: [task('AW-24', 'done')],
    });
    expect(whileDone).toEqual([]);

    // Derivation is a pure function of current state — closure never latches.
    const afterReopen = await deriveOpenLoops(initiativeDir, {
      now: NOW,
      tasks: [task('AW-24', 'open')],
    });
    expect(afterReopen.map((l) => l.ref)).toEqual([`${opener}#n1`]);
    expect(afterReopen[0]?.openedAt).toBe('2026-07-01T00:00:00Z');
    expect(afterReopen[0]?.ageDays).toBe(27);
  });

  it('auto-resolves a pr loop only from mergedPrs, with or without the # prefix', async () => {
    const opener = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [
        { id: 'n1', text: 'PR 57 awaiting review', kind: 'pr', ref: '#57' },
        { id: 'n2', text: 'PR 58 awaiting review', kind: 'pr', ref: '58' },
      ],
    });

    const withoutMerged = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(withoutMerged).toHaveLength(2);

    const loops = await deriveOpenLoops(initiativeDir, {
      now: NOW,
      mergedPrs: ['57'],
    });
    expect(loops.map((l) => l.ref)).toEqual([`${opener}#n2`]);
  });

  it('skips malformed session files without failing', async () => {
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', '2026-07-01-broken.md'),
      '---\nsession_id: broken\n---\n\nincomplete\n',
      'utf8',
    );
    const good = await writeSession({
      session_id: 'good',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'survives', kind: 'prose' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${good}#n1`]);
  });

  it('treats sessions with no ledger fields as opening no loops', async () => {
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', '2026-07-01-legacy.md'),
      '---\nsession_id: legacy\nstarted: 2026-07-01T00:00:00Z\nended: 2026-07-01T01:00:00Z\ntrack: canonical\n---\n\nold file\n',
      'utf8',
    );
    expect(await deriveOpenLoops(initiativeDir, { now: NOW })).toEqual([]);
  });
});

describe('findDanglingResolves', () => {
  it('reports resolves pointing at a next_step that does not exist', async () => {
    const opener = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'real loop', kind: 'prose' }],
    });
    const resolver = await writeSession({
      session_id: 'bbb',
      ended: '2026-07-05T00:00:00Z',
      resolves: [
        { ref: `${opener}#n1`, outcome: 'done' },
        { ref: `${opener}#n9`, outcome: 'done' },
        { ref: 'no-such-file#n1', outcome: 'done' },
      ],
    });

    expect(await findDanglingResolves(initiativeDir)).toEqual([
      { sessionFile: resolver, ref: `${opener}#n9`, kind: 'missing' },
      { sessionFile: resolver, ref: 'no-such-file#n1', kind: 'missing' },
    ]);
  });

  it('reports a resolve aimed at the session_id instead of the filename', async () => {
    await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'real loop', kind: 'prose' }],
    });
    const resolver = await writeSession({
      session_id: 'bbb',
      ended: '2026-07-05T00:00:00Z',
      resolves: [{ ref: 'aaa#n1', outcome: 'done' }],
    });

    expect(await findDanglingResolves(initiativeDir)).toEqual([
      { sessionFile: resolver, ref: 'aaa#n1', kind: 'missing' },
    ]);
  });

  it('reports a resolve that points forward in time', async () => {
    const early = await writeSession({
      session_id: 'early',
      ended: '2026-07-01T00:00:00Z',
      resolves: [{ ref: '2026-07-10-late#n1', outcome: 'done' }],
    });
    await writeSession({
      session_id: 'late',
      ended: '2026-07-10T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'later loop', kind: 'prose' }],
    });

    expect(await findDanglingResolves(initiativeDir)).toEqual([
      { sessionFile: early, ref: '2026-07-10-late#n1', kind: 'not-prior' },
    ]);
  });

  it('distinguishes a rejected out-of-order close from a bad ref', async () => {
    // Parallel worktrees: A ran 09:00-17:00, B ran 10:00-16:00 but wrapped last
    // and closed A's loop. The ref is correct; only the ordering rejects it.
    const longRunning = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T17:00:00Z',
      next_steps: [{ id: 'n1', text: 'from the long worktree', kind: 'prose' }],
    });
    const shortRunning = await writeSession({
      session_id: 'bbb',
      ended: '2026-07-01T16:00:00Z',
      resolves: [{ ref: `${longRunning}#n1`, outcome: 'done' }],
    });

    expect(await findDanglingResolves(initiativeDir)).toEqual([
      { sessionFile: shortRunning, ref: `${longRunning}#n1`, kind: 'not-prior' },
    ]);
    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${longRunning}#n1`]);
  });

  it('returns nothing when every resolve lands', async () => {
    const opener = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'real loop', kind: 'prose' }],
    });
    await writeSession({
      session_id: 'bbb',
      ended: '2026-07-05T00:00:00Z',
      resolves: [{ ref: `${opener}#n1`, outcome: 'done' }],
    });

    expect(await findDanglingResolves(initiativeDir)).toEqual([]);
  });
});

describe('self-resolution', () => {
  it('rejects a session resolving a loop it opened in the same file', async () => {
    // Otherwise `wrap`'s non-empty-ledger gate is defeatable: file one
    // next_step plus a resolve naming your own (predictable) stem.
    const stem = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'closed by itself', kind: 'prose' }],
      resolves: [{ ref: '2026-07-01-aaa#n1', outcome: 'done' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${stem}#n1`]);
    expect(await findDanglingResolves(initiativeDir)).toEqual([
      { sessionFile: stem, ref: `${stem}#n1`, kind: 'self' },
    ]);
  });

  it('rejects a self-directed resolve that a filename collision aimed at the earlier file', async () => {
    // The caller predicted its own stem, but `pickAvailableFilename` parked it
    // at `-1`, so the ref now names a *different* record's live loop.
    const earlier = await writeSession({
      session_id: 'dupe',
      file: '2026-07-01-1000-dupe',
      ended: '2026-07-01T10:00:00Z',
      next_steps: [{ id: 'n1', text: 'must stay open', kind: 'prose' }],
    });
    const collided = await writeSession({
      session_id: 'dupe',
      file: '2026-07-01-1000-dupe-1',
      ended: '2026-07-01T11:00:00Z',
      resolves: [{ ref: `${earlier}#n1`, outcome: 'done' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${earlier}#n1`]);
    expect(await findDanglingResolves(initiativeDir)).toEqual([
      { sessionFile: collided, ref: `${earlier}#n1`, kind: 'self' },
    ]);
  });

  it('rejects a resolve cycle between two sessions sharing an `ended`', async () => {
    const a = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'a loop', kind: 'prose' }],
      resolves: [{ ref: '2026-07-01-bbb#n1', outcome: 'done' }],
    });
    const b = await writeSession({
      session_id: 'bbb',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'b loop', kind: 'prose' }],
      resolves: [{ ref: '2026-07-01-aaa#n1', outcome: 'done' }],
    });

    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref).sort()).toEqual([`${a}#n1`, `${b}#n1`]);
    expect(await findDanglingResolves(initiativeDir)).toEqual([
      { sessionFile: a, ref: `${b}#n1`, kind: 'not-prior' },
      { sessionFile: b, ref: `${a}#n1`, kind: 'not-prior' },
    ]);
  });
});

describe('findSessionIssues', () => {
  it('reports nothing for a healthy initiative', async () => {
    await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'open', kind: 'prose' }],
    });

    expect(await findSessionIssues(initiativeDir)).toEqual({ dangling: [], malformed: [] });
  });

  it('reports a malformed session that both drops its loops and re-opens a resolved one', async () => {
    const opener = await writeSession({
      session_id: 'aaa',
      ended: '2026-07-01T00:00:00Z',
      next_steps: [{ id: 'n1', text: 'was legitimately closed', kind: 'prose' }],
    });
    // `track` holding a branch name — the exact shape found in live data.
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', '2026-07-05-broken.md'),
      [
        '---',
        'session_id: broken',
        'started: 2026-07-05T00:00:00Z',
        'ended: 2026-07-05T00:00:00Z',
        'track: feat/tts-quality',
        'next_steps:',
        '  - id: n9',
        '    text: lost with the file',
        '    kind: prose',
        'resolves:',
        `  - ref: ${opener}#n1`,
        '    outcome: done',
        '---',
        '',
        'narrative',
        '',
      ].join('\n'),
      'utf8',
    );

    // The loop the broken file closed is back open and its own loop is gone —
    // invisible in the ledger, so the issue report is the only signal.
    const loops = await deriveOpenLoops(initiativeDir, { now: NOW });
    expect(loops.map((l) => l.ref)).toEqual([`${opener}#n1`]);

    const issues = await findSessionIssues(initiativeDir);
    expect(issues.dangling).toEqual([]);
    expect(issues.malformed).toHaveLength(1);
    expect(issues.malformed[0]?.file).toBe('2026-07-05-broken.md');
    expect(issues.malformed[0]?.reason).toContain('track');
  });

  it('reports a non-session file living in sessions/ as having no frontmatter', async () => {
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', 'ARCHIVED-handoff.md'),
      '# hand-placed archive\n\nno frontmatter at all\n',
      'utf8',
    );

    const issues = await findSessionIssues(initiativeDir);
    expect(issues.malformed).toEqual([
      { file: 'ARCHIVED-handoff.md', reason: 'no frontmatter block' },
    ]);
  });

  it('reports unparseable YAML separately from schema failures', async () => {
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', '2026-07-01-badyaml.md'),
      '---\nsession_id: "unterminated\nended: 2026-07-01T00:00:00Z\n---\n\nnarrative\n',
      'utf8',
    );

    const issues = await findSessionIssues(initiativeDir);
    expect(issues.malformed[0]?.reason).toMatch(/invalid YAML/);
  });
});

describe('deriveOpenLoopsFrom', () => {
  it('derives without touching the disk again', async () => {
    const opener = await writeSession({
      session_id: 'a',
      ended: '2026-07-20T10:00:00Z',
      next_steps: [{ id: 'n1', text: 'a loop', kind: 'prose' }],
    });
    const loaded = await loadSessionsFromDir(initiativeDir);

    // Removing the source proves the second pass reads nothing: a loader that
    // re-read the directory here would come back empty.
    rmSync(path.join(initiativeDir, 'sessions'), { recursive: true, force: true });
    const loops = deriveOpenLoopsFrom(loaded, { now: NOW });

    expect(loops.map((l) => l.ref)).toEqual([`${opener}#n1`]);
  });

  it('matches deriveOpenLoops for the same directory', async () => {
    const opener = await writeSession({
      session_id: 'a',
      ended: '2026-07-20T10:00:00Z',
      next_steps: [
        { id: 'n1', text: 'first', kind: 'prose' },
        { id: 'n2', text: 'second', kind: 'prose' },
      ],
    });
    await writeSession({
      session_id: 'b',
      ended: '2026-07-22T10:00:00Z',
      resolves: [{ ref: `${opener}#n1`, outcome: 'done' }],
    });

    const fromDir = await deriveOpenLoops(initiativeDir, { now: NOW });
    const preloaded = deriveOpenLoopsFrom(
      await loadSessionsFromDir(initiativeDir),
      { now: NOW },
    );

    expect(preloaded).toEqual(fromDir);
    expect(preloaded.map((l) => l.ref)).toEqual([`${opener}#n2`]);
  });
});

describe('loadSessionsFromDir', () => {
  it('exposes the body so bootstrap renders what derivation parsed', async () => {
    await writeSession({ session_id: 'a', ended: '2026-07-20T10:00:00Z' });
    const { sessions, malformed } = await loadSessionsFromDir(initiativeDir);
    expect(malformed).toEqual([]);
    expect(sessions[0]?.body.trim()).toBe('narrative');
  });

  it('reports an unreadable file instead of silently skipping it', async () => {
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', 'broken.md'),
      'no frontmatter here\n',
      'utf8',
    );
    const { sessions, malformed } = await loadSessionsFromDir(initiativeDir);
    expect(sessions).toEqual([]);
    expect(malformed).toEqual([
      { file: 'broken.md', reason: 'no frontmatter block' },
    ]);
  });
});
