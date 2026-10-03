import Database from 'better-sqlite3';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { runRefresh, type RefreshSummary } from '../../src/session-index/refresh.js';
import { retiredSessions, SEAL_GRACE_MS } from '../../src/session-index/retired.js';

// Same shape as `origin-agent-chat.test.ts`, trimmed to the columns read here.
const EVENTS_DDL = `
CREATE TABLE events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  kind   TEXT    NOT NULL,
  actor  TEXT    NOT NULL,
  target TEXT,
  msg_id TEXT,
  ref    TEXT,
  body   TEXT,
  meta   TEXT
);`;

const SESSION = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';

let dir: string;
let root: string;
let home: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-retired-'));
  root = path.join(dir, 'projects');
  home = path.join(dir, 'agent-chat');
  mkdirSync(path.join(root, 'demo', SESSION, 'subagents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', home);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const line = (sessionId: string, text: string): string =>
  `${JSON.stringify({
    type: 'user',
    sessionId,
    uuid: `u-${sessionId.slice(0, 8)}-${text.length}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`;

const transcriptOf = (sessionId: string): string => path.join(root, 'demo', `${sessionId}.jsonl`);

function writeEvents(rows: { ts: number; kind: string; sessionId: string }[]): void {
  const db = new Database(path.join(home, 'events.db'));
  db.exec(EVENTS_DDL);
  const insert = db.prepare('INSERT INTO events (ts, kind, actor, meta) VALUES (?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.ts, row.kind, 'worker', JSON.stringify({ session_id: row.sessionId }));
  }
  db.close();
}

const retire = (sessionId: string, agoMs = SEAL_GRACE_MS + 60_000): void =>
  writeEvents([{ ts: Date.now() - agoMs, kind: 'agent_retired', sessionId }]);

const pass = (): Promise<RefreshSummary> =>
  runRefresh({ graph, root, skipPrOutcomes: true, skipWorkspace: true, taskRoot: dir });

const rowFor = (sessionId: string) =>
  graph.transcripts.list().find((row) => row.sourceKey.endsWith(`${sessionId}.jsonl`));

describe('sealed transcripts of retired agents', () => {
  it('skips a retired session once the index has read it to the end', async () => {
    writeFileSync(transcriptOf(SESSION), line(SESSION, 'final words'), 'utf8');
    writeFileSync(transcriptOf(OTHER), line(OTHER, 'still working'), 'utf8');
    retire(SESSION);

    const first = await pass();
    const second = await pass();

    expect(first).toMatchObject({ transcripts: 2, scanned: 2, indexed: 2 });
    expect(second).toMatchObject({ transcripts: 2, scanned: 1, unchanged: 1, filesOpened: 0 });
    expect(second.reconciledMissing).toBe(0);
    expect(rowFor(SESSION)?.status).toBe('ok');
  });

  it('indexes the unread bytes of a retired session once, then seals it', async () => {
    writeFileSync(transcriptOf(SESSION), line(SESSION, 'first prompt'), 'utf8');
    await pass();
    const tail = line(SESSION, 'the last thing it wrote before retiring');
    appendFileSync(transcriptOf(SESSION), tail, 'utf8');
    retire(SESSION, 0);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + SEAL_GRACE_MS + 60_000);

    const catchUp = await pass();
    const sealed = await pass();

    expect(catchUp).toMatchObject({ scanned: 1, indexed: 1, bytesRead: Buffer.byteLength(tail) });
    expect(sealed).toMatchObject({ transcripts: 1, scanned: 0 });
  });

  it('seals a retired session read before its retire once a stat shows no tail', async () => {
    writeFileSync(transcriptOf(SESSION), line(SESSION, 'all it ever wrote'), 'utf8');
    await pass();
    retire(SESSION, 0);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SEAL_GRACE_MS + 60_000);

    const sealed = await pass();

    expect(sealed).toMatchObject({ transcripts: 1, scanned: 0 });
    expect(rowFor(SESSION)?.status).toBe('ok');
  });

  it('keeps visiting a retired session whose last line was never completed', async () => {
    const partial = JSON.stringify({ type: 'user', sessionId: SESSION }).slice(0, 20);
    writeFileSync(transcriptOf(SESSION), `${line(SESSION, 'complete')}${partial}`, 'utf8');
    retire(SESSION);

    await pass();
    const second = await pass();

    expect(second).toMatchObject({ transcripts: 1, scanned: 1 });
  });

  it('skips the subagent transcripts under a sealed retired session', async () => {
    writeFileSync(transcriptOf(SESSION), line(SESSION, 'parent'), 'utf8');
    const sidechain = path.join(root, 'demo', SESSION, 'subagents', 'agent-x1.jsonl');
    writeFileSync(sidechain, line(SESSION, 'subagent'), 'utf8');
    retire(SESSION);

    await pass();
    const second = await pass();

    expect(second).toMatchObject({ transcripts: 2, scanned: 0 });
  });

  it('keeps visiting a session retired within the grace window', async () => {
    writeFileSync(transcriptOf(SESSION), line(SESSION, 'just retired'), 'utf8');
    retire(SESSION, 60_000);

    await pass();
    const second = await pass();

    expect(second).toMatchObject({ scanned: 1, unchanged: 1 });
  });
});

describe('retiredSessions', () => {
  it('forgets a retire that a later resume undid', () => {
    writeEvents([
      { ts: 1_000, kind: 'agent_retired', sessionId: SESSION },
      { ts: 2_000, kind: 'agent_resumed', sessionId: SESSION },
      { ts: 3_000, kind: 'agent_retired', sessionId: OTHER },
    ]);

    expect([...retiredSessions()]).toEqual([[OTHER, 3_000]]);
  });

  it('fails open to an empty map when the events record cannot be read', () => {
    const unreadable = {
      events: () => {
        throw new Error('database is locked');
      },
      plan: () => null,
    };

    expect(retiredSessions(unreadable).size).toBe(0);
    expect(retiredSessions().size).toBe(0);
  });
});
