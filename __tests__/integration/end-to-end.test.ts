/**
 * End-to-end integration: drives the command registry directly across module
 * boundaries. Each test isolates state via an in-process `ACTIVE_ROOT` env
 * stub plus an env-stubbed HOME so the operator's real data is never touched.
 *
 * We import commands from the registry rather than re-declaring schemas so a
 * regression in any single command surfaces here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  promises as fs,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import '../../src/commands/index.js';
import { registry } from '../../src/registry/index.js';
import type { CommandContext } from '../../src/registry/types.js';

interface RunOpts {
  ctx?: Partial<CommandContext>;
}

async function runCmd<T = unknown>(
  name: string,
  args: unknown,
  activeRoot: string,
  opts: RunOpts = {},
): Promise<T> {
  const cmd = registry.get(name);
  if (!cmd) throw new Error(`unknown command: ${name}`);
  const parsed = cmd.args.parse(args ?? {});
  const ctx: CommandContext = {
    activeRoot,
    warnings: [],
    format: 'json',
    ...opts.ctx,
  };
  return (await cmd.run(parsed, ctx)) as T;
}

interface InitiativeNewResult {
  slug: string;
  dir: string;
  rank: number;
  task_prefix: string;
}

interface ListSection {
  heading: string;
  items: Array<{ slug: string; title: string; state: string; rank?: number }>;
}

interface ListResult {
  sections: ListSection[];
  parse_errors: Array<{ slug: string; error: string }>;
}

interface AuditResult {
  initiatives: Array<{ slug: string; state: string; rank?: number }>;
  parse_errors: unknown[];
  worktree_conflicts: unknown[];
}

interface OpenResult {
  slug: string;
  prompt: string;
  cwd_hint: string;
  metadata: { brief_title: string };
}

interface DiscoverHit {
  source: string;
  ref: string;
  metadata?: Record<string, unknown>;
}

interface DiscoverResult {
  hits: DiscoverHit[];
  errors: unknown[];
}

interface SessionRecordResult {
  path: string;
  filename: string;
}

interface SessionListResult {
  sessions: Array<{ filename: string; first_line: string }>;
  errors: unknown[];
}

interface TaskListResult {
  tasks: Array<{ id: string; slug: string; status: string; priority: number; tags?: string[] }>;
}

const ROOT_STACK: string[] = [];

function pushRoot(dir: string): void {
  ROOT_STACK.push(process.env.ACTIVE_ROOT ?? '');
  process.env.ACTIVE_ROOT = dir;
}

function popRoot(): void {
  const prev = ROOT_STACK.pop();
  if (prev === undefined || prev === '') {
    delete process.env.ACTIVE_ROOT;
  } else {
    process.env.ACTIVE_ROOT = prev;
  }
}

describe('end-to-end: full lifecycle through the registry', () => {
  let scopeDir: string;
  let activeRoot: string;
  let homeDir: string;
  let claudeProjectsDir: string;

  beforeAll(() => {
    expect(registry.size).toBeGreaterThan(30);
  });

  beforeEach(() => {
    // Wrap activeRoot in a scope dir so `archive` (which writes to
    // <activeRoot>/..) lands inside our cleanup zone.
    scopeDir = mkdtempSync(path.join(tmpdir(), 'aw-e2e-scope-'));
    activeRoot = path.join(scopeDir, 'active');
    mkdirSync(activeRoot);
    homeDir = mkdtempSync(path.join(tmpdir(), 'aw-e2e-home-'));
    claudeProjectsDir = mkdtempSync(path.join(tmpdir(), 'aw-e2e-claude-'));
    pushRoot(activeRoot);
    process.env.HOME = homeDir;
    process.env.CLAUDE_PROJECTS_ROOT = claudeProjectsDir;
  });

  afterEach(() => {
    popRoot();
    delete process.env.CLAUDE_PROJECTS_ROOT;
    rmSync(scopeDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(claudeProjectsDir, { recursive: true, force: true });
  });

  it('initiative lifecycle: new -> task.add -> task.done -> open -> audit -> list -> archive', async () => {
    const created = await runCmd<InitiativeNewResult>(
      'new',
      { slug: 'e2e-test', title: 'E2E Test', ship_target: '2026-Q4' },
      activeRoot,
    );
    expect(created.slug).toBe('e2e-test');
    expect(created.dir).toBe(path.join(activeRoot, 'e2e-test'));
    expect(created.task_prefix).toBe('ET');

    const t1 = await runCmd<{ id: string }>(
      'task.add',
      { slug: 'e2e-test', title: 'First task', priority: 1 },
      activeRoot,
    );
    const t2 = await runCmd<{ id: string }>(
      'task.add',
      { slug: 'e2e-test', title: 'Second task', priority: 2 },
      activeRoot,
    );
    expect(t1.id).toBe('ET-1');
    expect(t2.id).toBe('ET-2');

    await runCmd('task.done', { slug: 'e2e-test', id: t1.id }, activeRoot);

    const opened = await runCmd<OpenResult>('open', { slug: 'e2e-test' }, activeRoot);
    expect(opened.metadata.brief_title).toBe('E2E Test');
    expect(opened.prompt).toContain('E2E Test');
    expect(opened.prompt).toContain('Second task');
    expect(opened.prompt).toContain('Tasks (top');
    // Recently-done window includes the task we just completed.
    expect(opened.prompt).toContain('First task');

    const audit = await runCmd<AuditResult>('audit', {}, activeRoot);
    expect(audit.initiatives).toHaveLength(1);
    expect(audit.initiatives[0]?.slug).toBe('e2e-test');
    expect(audit.parse_errors).toEqual([]);
    expect(audit.worktree_conflicts).toEqual([]);

    const listed = await runCmd<ListResult>('list', {}, activeRoot);
    const focused = listed.sections.find((s) => s.heading === 'Focused');
    expect(focused?.items.map((i) => i.slug)).toContain('e2e-test');

    await runCmd('archive', { slug: 'e2e-test', domain: 'engineering' }, activeRoot);
    const after = await runCmd<ListResult>('list', {}, activeRoot);
    const totalAfter = after.sections.reduce((acc, s) => acc + s.items.length, 0);
    expect(totalAfter).toBe(0);
  });

  it('focus/pause flow: re-rank, pause moves to paused, unpause moves to backburner', async () => {
    await runCmd('new', { slug: 'init-a', title: 'A' }, activeRoot);
    await runCmd('new', { slug: 'init-b', title: 'B' }, activeRoot);
    await runCmd('new', { slug: 'init-c', title: 'C' }, activeRoot);

    // After three creates, ranks should be a=1, b=2, c=3.
    let listed = await runCmd<ListResult>('list', {}, activeRoot);
    let focused = listed.sections.find((s) => s.heading === 'Focused')!;
    const rankBefore = new Map(focused.items.map((i) => [i.slug, i.rank]));
    expect(rankBefore.get('init-a')).toBe(1);
    expect(rankBefore.get('init-b')).toBe(2);
    expect(rankBefore.get('init-c')).toBe(3);

    // Promote c to rank 1.
    await runCmd('focus', { slug: 'init-c', rank: 1 }, activeRoot);
    listed = await runCmd<ListResult>('list', {}, activeRoot);
    focused = listed.sections.find((s) => s.heading === 'Focused')!;
    const rankAfter = new Map(focused.items.map((i) => [i.slug, i.rank]));
    expect(rankAfter.get('init-c')).toBe(1);
    expect(rankAfter.get('init-a')).toBe(2);
    expect(rankAfter.get('init-b')).toBe(3);

    // Pause init-a. Survivors compact to c=1, b=2.
    await runCmd(
      'pause',
      { slug: 'init-a', since: '2026-05-12', restart_trigger: 'wait for design review' },
      activeRoot,
    );
    listed = await runCmd<ListResult>('list', {}, activeRoot);
    focused = listed.sections.find((s) => s.heading === 'Focused')!;
    const paused = listed.sections.find((s) => s.heading === 'Paused')!;
    expect(paused.items.map((i) => i.slug)).toContain('init-a');
    const rankPaused = new Map(focused.items.map((i) => [i.slug, i.rank]));
    expect(rankPaused.get('init-c')).toBe(1);
    expect(rankPaused.get('init-b')).toBe(2);

    // Unpause init-a -> backburner.
    await runCmd('unpause', { slug: 'init-a' }, activeRoot);
    listed = await runCmd<ListResult>('list', {}, activeRoot);
    const backburner = listed.sections.find((s) => s.heading === 'Backburner')!;
    expect(backburner.items.map((i) => i.slug)).toContain('init-a');
    const focusedAfter = listed.sections.find((s) => s.heading === 'Focused')!;
    expect(focusedAfter.items.map((i) => i.slug)).not.toContain('init-a');

    const audit = await runCmd<AuditResult>('audit', {}, activeRoot);
    const states = new Map(audit.initiatives.map((i) => [i.slug, i.state]));
    expect(states.get('init-a')).toBe('backburner');
    expect(states.get('init-b')).toBe('focused');
    expect(states.get('init-c')).toBe('focused');
    expect(audit.parse_errors).toEqual([]);
  });

  it('tasks across initiatives: --all-initiatives + --tag filter', async () => {
    await runCmd('new', { slug: 'multi-a', title: 'Multi A' }, activeRoot);
    await runCmd('new', { slug: 'multi-b', title: 'Multi B' }, activeRoot);

    await runCmd('task.add', { slug: 'multi-a', title: 'A1', tags: ['backend'] }, activeRoot);
    await runCmd('task.add', { slug: 'multi-a', title: 'A2', tags: ['frontend'] }, activeRoot);
    await runCmd('task.add', { slug: 'multi-b', title: 'B1', tags: ['backend'] }, activeRoot);
    await runCmd('task.add', { slug: 'multi-b', title: 'B2', tags: ['ops'] }, activeRoot);

    const all = await runCmd<TaskListResult>(
      'task.list',
      { all_initiatives: true, status: 'open' },
      activeRoot,
    );
    expect(all.tasks).toHaveLength(4);
    const slugs = new Set(all.tasks.map((t) => t.slug));
    expect(slugs.has('multi-a')).toBe(true);
    expect(slugs.has('multi-b')).toBe(true);

    const tagged = await runCmd<TaskListResult>(
      'task.list',
      { all_initiatives: true, status: 'open', tag: 'backend' },
      activeRoot,
    );
    expect(tagged.tasks).toHaveLength(2);
    for (const t of tagged.tasks) {
      expect(t.tags ?? []).toContain('backend');
    }
  });

  it('discover triage: hit appears, fold suppresses it on the next discover', async () => {
    // Set up an initiative so the cross-reference step has something to match.
    await runCmd('new', { slug: 'triage-target', title: 'Triage Target' }, activeRoot);

    // Craft a single Claude session JSONL whose cwd is unrelated.
    const projectDir = path.join(claudeProjectsDir, '-Users-anon-code-orphan-work');
    mkdirSync(projectDir);
    const sessionRef = '/Users/anon/code/orphan-work';
    writeFileSync(
      path.join(projectDir, 'sess-1.jsonl'),
      JSON.stringify({
        type: 'user',
        cwd: sessionRef,
        message: { content: 'pick this back up' },
      }) + '\n',
    );

    const first = await runCmd<DiscoverResult>('discover', {}, activeRoot);
    const claudeHit = first.hits.find((h) => h.source === 'claude-session' && h.ref === sessionRef);
    expect(claudeHit).toBeDefined();

    await runCmd(
      'fold',
      { ref: sessionRef, into: 'triage-target', note: 'absorbed' },
      activeRoot,
    );

    const second = await runCmd<DiscoverResult>('discover', {}, activeRoot);
    const stillThere = second.hits.find((h) => h.source === 'claude-session' && h.ref === sessionRef);
    expect(stillThere).toBeUndefined();
  });

  it('sessions roundtrip: record -> list -> filename collision yields -1 suffix', async () => {
    await runCmd('new', { slug: 'sess-test', title: 'Sess' }, activeRoot);

    const started = '2026-05-12T15:23:45.000Z';
    const ended = '2026-05-12T16:00:00.000Z';
    const body = 'First-line preview\nSecond line of body content.\n';

    const first = await runCmd<SessionRecordResult>(
      'session.record',
      {
        slug: 'sess-test',
        session_id: 'abc123',
        started,
        ended,
        track: 'canonical',
        body,
      },
      activeRoot,
    );
    expect(first.filename).toBe('2026-05-12-1523-abc123.md');

    const listed = await runCmd<SessionListResult>(
      'session.list',
      { slug: 'sess-test' },
      activeRoot,
    );
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?.filename).toBe(first.filename);
    expect(listed.sessions[0]?.first_line).toBe('First-line preview');

    // Same session_id + started timestamp -> -1 collision suffix.
    const second = await runCmd<SessionRecordResult>(
      'session.record',
      {
        slug: 'sess-test',
        session_id: 'abc123',
        started,
        ended,
        track: 'canonical',
        body: 'Other body',
      },
      activeRoot,
    );
    expect(second.filename).toBe('2026-05-12-1523-abc123-1.md');
    const exists = await fs
      .stat(path.join(activeRoot, 'sess-test', 'sessions', second.filename))
      .then((s) => s.isFile())
      .catch(() => false);
    expect(exists).toBe(true);
  });
});
