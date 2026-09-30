import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOrigins, sessionsNeedingOrigin } from '@titan-design/session-graph';

import { openGraph } from '../../src/session-index/graph.js';
import {
  agentChatOriginResolver,
  BRIEF_EXCERPT_CHARS,
  eventsDbSource,
  resolveFromSource,
  type IsKnownTask,
  type OpenDatabase,
} from '../../src/session-index/origin-agent-chat.js';

// Copied from `sqlite3 ~/.agent-chat/events.db .schema` on 2026-09-23.
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
);
CREATE INDEX events_target ON events(target, id);
CREATE INDEX events_msg_id ON events(msg_id);
CREATE INDEX events_ref ON events(ref);
CREATE INDEX events_kind ON events(kind, id);
`;

const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const COORD_SESSION = '11111111-0000-0000-0000-000000000000';
const WORKER_SESSION = '22222222-0000-0000-0000-000000000000';

interface Row {
  ts: number;
  kind: string;
  actor: string;
  target?: string;
  ref?: string;
  meta?: Record<string, string>;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'aw-agent-chat-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeEvents(rows: Row[]): string {
  const file = path.join(home, 'events.db');
  const db = new Database(file);
  db.exec(EVENTS_DDL);
  const insert = db.prepare(
    'INSERT INTO events (ts, kind, actor, target, ref, meta) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    insert.run(
      r.ts,
      r.kind,
      r.actor,
      r.target ?? null,
      r.ref ?? null,
      JSON.stringify(r.meta ?? {}),
    );
  }
  db.close();
  return file;
}

function writePlan(agentId: string, plan: Record<string, unknown>): string {
  const dir = path.join(home, 'agents', agentId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify({ agentId, bin: 'claude', ...plan }), 'utf8');
  return file;
}

function adoptedCoordinator(name: string, agentId: string, ts = T0): Row[] {
  return [
    {
      ts,
      kind: 'agent_spawned',
      actor: 'human',
      target: name,
      meta: { name, session_id: COORD_SESSION, depth: '0', origin: 'adopted', cwd: '/work' },
    },
    { ts: ts + 1, kind: 'agent_attached', actor: name, ref: agentId },
  ];
}

function spawnedWorker(
  parent: string,
  parentId: string | null,
  ts = T0 + 1_000,
  name = 'worker-1',
): Row[] {
  const meta: Record<string, string> = {
    name,
    profile: 'implementer',
    model: 'opus',
    surface: 'iterm-pane',
    isolation: 'worktree',
    cwd: '/work/.worktrees/worker-1',
    session_id: WORKER_SESSION,
    config_dir: '/cfg/agents',
    depth: '1',
  };
  if (parentId) meta.parent = parentId;
  return [
    { ts, kind: 'agent_spawned', actor: parent, target: name, meta },
    { ts: ts + 500, kind: 'agent_attached', actor: name, ref: 'bbbb2222' },
  ];
}

const noKnownTasks: IsKnownTask = () => false;

function resolve(
  sessionIds: string[] = [COORD_SESSION, WORKER_SESSION],
  isKnown: IsKnownTask = noKnownTasks,
) {
  return resolveFromSource(eventsDbSource(home), sessionIds, isKnown);
}

describe('agent-chat origin adapter', () => {
  it('resolves profile, parent, name, isolation, depth and config_dir for a spawned worker', () => {
    writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111'),
    ]);

    const { origins } = resolve();

    expect(origins[WORKER_SESSION]).toMatchObject({
      originSystem: 'agent-chat',
      agentId: 'bbbb2222',
      agentName: 'worker-1',
      parentName: 'coord',
      parentSessionId: COORD_SESSION,
      profile: 'implementer',
      modelAlias: 'opus',
      isolation: 'worktree',
      depth: 1,
      originKind: 'spawned',
      configDir: '/cfg/agents',
      spawnCwd: '/work/.worktrees/worker-1',
      spawnedAt: new Date(T0 + 1_000).toISOString(),
    });
    expect(origins[COORD_SESSION]).toMatchObject({
      agentId: 'aaaa1111',
      depth: 0,
      originKind: 'adopted',
      parentSessionId: null,
    });
  });

  it("resolves the parent session id from the parent's own spawn row", () => {
    const renamed: Row[] = [
      ...adoptedCoordinator('example-coord-6335', 'aaaa1111'),
      { ts: T0 + 100, kind: 'agent_attached', actor: 'example-wave3', ref: 'aaaa1111' },
    ];
    const legacySession = '33333333-0000-0000-0000-000000000000';
    const legacyChild: Row = {
      ts: T0 + 2_000,
      kind: 'agent_spawned',
      actor: 'example-coord-6335',
      target: 'legacy',
      meta: { name: 'legacy', session_id: legacySession, depth: '1' },
    };
    const readopted: Row = {
      ts: T0 + 3_000,
      kind: 'agent_spawned',
      actor: 'example-coord-6335',
      target: 'example-coord-6335',
      meta: { name: 'example-coord-6335', session_id: 'later-session', depth: '0' },
    };
    writeEvents([
      ...renamed,
      ...spawnedWorker('example-wave3', 'aaaa1111'),
      legacyChild,
      readopted,
    ]);

    const { origins } = resolve([WORKER_SESSION, legacySession, 'later-session']);

    expect(origins[WORKER_SESSION]?.parentSessionId).toBe(COORD_SESSION);
    expect(origins[legacySession]?.parentSessionId).toBe(COORD_SESSION);
    expect(origins['later-session']?.parentSessionId).toBeNull();
  });

  it('reads brief length and excerpt from plan.json', () => {
    writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111'),
    ]);
    const brief = `Task: T17. ${'x'.repeat(600)}`;
    const planPath = writePlan('bbbb2222', { args: ['--model', 'opus'], stdin: brief });
    writePlan('aaaa1111', { args: ['--model', 'opus', '--', 'pane prompt'] });

    const { origins } = resolve();

    expect(origins[WORKER_SESSION]).toMatchObject({
      briefChars: brief.length,
      briefExcerpt: brief.slice(0, BRIEF_EXCERPT_CHARS),
      briefPath: planPath,
    });
    expect(origins[COORD_SESSION]).toMatchObject({ briefChars: 11, briefExcerpt: 'pane prompt' });
  });

  it('maps agent_resumed with from_surface to a teleport event', () => {
    const resumedAt = T0 + 5_000;
    writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111'),
      {
        ts: resumedAt,
        kind: 'agent_resumed',
        actor: 'coord',
        target: 'worker-1',
        ref: 'bbbb2222',
        meta: { session_id: WORKER_SESSION, surface: 'iterm-pane', from_surface: 'headless' },
      },
      { ts: resumedAt + 1, kind: 'agent_resumed', actor: 'coord', ref: 'bbbb2222', meta: {} },
      {
        ts: resumedAt + 2,
        kind: 'agent_exited',
        actor: 'worker-1',
        ref: 'bbbb2222',
        meta: { code: '0' },
      },
      {
        ts: resumedAt + 3,
        kind: 'agent_handoff',
        actor: 'worker-1',
        ref: 'bbbb2222',
        meta: { successor: 'cccc3333' },
      },
      {
        ts: resumedAt + 4,
        kind: 'agent_retired',
        actor: 'human',
        target: 'worker-1',
        ref: 'bbbb2222',
        meta: { reaped: 'true' },
      },
    ]);

    const { externalEvents } = resolve([WORKER_SESSION]);

    expect(externalEvents).toEqual([
      {
        sessionId: WORKER_SESSION,
        ts: new Date(resumedAt).toISOString(),
        kind: 'teleport',
        detail: 'headless to iterm-pane',
        originSystem: 'agent-chat',
      },
      {
        sessionId: WORKER_SESSION,
        ts: new Date(resumedAt + 2).toISOString(),
        kind: 'exited',
        detail: 'code 0',
        originSystem: 'agent-chat',
      },
      {
        sessionId: WORKER_SESSION,
        ts: new Date(resumedAt + 3).toISOString(),
        kind: 'handoff',
        detail: 'successor cccc3333',
        originSystem: 'agent-chat',
      },
      {
        sessionId: WORKER_SESSION,
        ts: new Date(resumedAt + 4).toISOString(),
        kind: 'retired',
        detail: 'reaped',
        originSystem: 'agent-chat',
      },
    ]);
  });

  it('a missing events.db resolves nothing and does not throw', () => {
    const resolution = resolve();

    expect(resolution).toEqual({ origins: {}, externalEvents: [] });
  });

  it('never opens the database for writing', () => {
    const file = writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111'),
    ]);
    const past = new Date(T0);
    utimesSync(file, past, past);
    const mtimeBefore = statSync(file).mtimeMs;
    const opened: Database.Options[] = [];
    const spy: OpenDatabase = (target, options) => {
      opened.push(options);
      return new Database(target, options);
    };

    const { origins } = resolveFromSource(
      eventsDbSource(home, spy),
      [WORKER_SESSION],
      noKnownTasks,
    );

    expect(origins[WORKER_SESSION]).toBeDefined();
    expect(opened).toEqual([expect.objectContaining({ readonly: true })]);
    expect(statSync(file).mtimeMs).toBe(mtimeBefore);
  });
});

function orientedBrief(assignment: string): string {
  const openTasks = Array.from(
    { length: 25 },
    (_, i) => `- TP-${i + 1}: synthetic open task ${i + 1}`,
  );
  return [
    '# Orientation: active-work initiative "example"',
    '## Brief (brief.md)\n\nThe example initiative tracks TP-2 as its first milestone.',
    `## Open tasks (25, highest priority first)\n\n${openTasks.join('\n')}`,
    '## Related to this assignment (1, ranked; open with Read)\n\n- task:CC-9 "a related task"',
    assignment,
  ].join('\n\n');
}

function knownOnly(...ids: string[]): IsKnownTask {
  const known = new Set(ids);
  return (id) => known.has(id);
}

function writeTaskFile(root: string, file: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), 'id: synthetic\n', 'utf8');
}

describe('agent-chat origin task links', () => {
  it('fills taskIds from a pane plan whose brief carries an orientation block', () => {
    writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111'),
    ]);
    const brief = orientedBrief('Task TP-31: add the widget.');
    writePlan('bbbb2222', { args: ['--model', 'opus', '--', brief] });
    const isKnown = knownOnly(
      'TP-2',
      'TP-31',
      'CC-9',
      ...Array.from({ length: 25 }, (_, i) => `TP-${i + 1}`),
    );

    const { origins } = resolve([WORKER_SESSION], isKnown);

    expect(brief.indexOf('TP-31')).toBeGreaterThan(BRIEF_EXCERPT_CHARS);
    expect(origins[WORKER_SESSION]).toMatchObject({
      taskIds: ['TP-31'],
      taskSource: 'brief-anchor',
    });
  });

  it('links from the agent name when the plan.json is missing', () => {
    writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111', T0 + 1_000, 'tp-31-impl'),
    ]);

    const { origins } = resolve([WORKER_SESSION], knownOnly('TP-31'));

    expect(origins[WORKER_SESSION]).toMatchObject({ taskIds: ['TP-31'], taskSource: 'name' });
  });

  it('an unlinked session gets empty taskIds and source none', () => {
    writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111'),
    ]);
    writePlan('bbbb2222', { stdin: 'Review the docs for tone.' });

    const { origins } = resolve();

    expect(origins[WORKER_SESSION]).toMatchObject({ taskIds: [], taskSource: 'none' });
    expect(origins[COORD_SESSION]).toMatchObject({ taskIds: [], taskSource: 'none' });
  });

  it('an archived task still links', async () => {
    writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111'),
    ]);
    writePlan('bbbb2222', { stdin: 'Task TP-31: add the widget.' });
    const taskRoot = path.join(home, 'active');
    writeTaskFile(taskRoot, 'example/tasks/archive/TP-31.yml');
    writeTaskFile(taskRoot, 'example/tasks/TP-32.yml');

    const { origins } = await agentChatOriginResolver(
      eventsDbSource(home),
      taskRoot,
    )([WORKER_SESSION]);

    expect(origins[WORKER_SESSION]).toMatchObject({
      taskIds: ['TP-31'],
      taskSource: 'brief-anchor',
    });
  });

  it('a second pass offers no row the first pass examined', async () => {
    writeEvents([
      ...adoptedCoordinator('coord', 'aaaa1111'),
      ...spawnedWorker('coord', 'aaaa1111'),
    ]);
    writePlan('bbbb2222', { stdin: 'Review the docs for tone.' });
    const graph = openGraph(path.join(home, 'graph.sqlite3'));
    const addSession = graph.db.prepare(
      'INSERT INTO session (session_id, turn_count) VALUES (?, 0)',
    );
    for (const id of [COORD_SESSION, WORKER_SESSION]) addSession.run(id);
    const resolver = agentChatOriginResolver(eventsDbSource(home), path.join(home, 'active'));

    try {
      const first = await resolveOrigins(graph, resolver);
      const offered = sessionsNeedingOrigin(graph);

      expect(first).toMatchObject({ requested: 2, applied: 2, failed: false });
      expect(offered).toEqual([]);
    } finally {
      graph.db.close();
    }
  });
});
