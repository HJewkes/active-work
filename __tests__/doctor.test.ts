import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { runDoctor, type DoctorDeps, type DoctorCheck } from '../src/doctor.js';
import * as paths from '../src/utils/paths.js';

function statusOf(checks: DoctorCheck[], name: string): string {
  return checks.find((c) => c.name === name)!.status;
}

/** Write a session file from its frontmatter lines. */
async function writeSessionFile(
  initiativeDir: string,
  filename: string,
  frontmatter: string[],
): Promise<void> {
  await fs.writeFile(
    path.join(initiativeDir, 'sessions', filename),
    ['---', ...frontmatter, '---', '', 'narrative', ''].join('\n'),
    'utf8',
  );
}

describe('runDoctor', () => {
  let base: string;
  let activeRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'aw-doctor-'));
    activeRoot = path.join(base, 'active');
    homeDir = path.join(base, 'home');
    await fs.mkdir(activeRoot, { recursive: true });
    await fs.writeFile(path.join(activeRoot, '.schema-version'), '1\n', 'utf8');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A fully-healthy deps bag; individual tests override one field to break it. */
  function healthyDeps(): DoctorDeps {
    return {
      fs,
      activeRoot,
      homeDir,
      nodeVersion: 'v22.4.0',
      probeDaemon: async () => ({
        running: true,
        healthy: true,
        pid: 123,
        port: 7400,
        version: '0.1.0',
      }),
      supervisorActive: async () => ({ kind: 'launchd', active: true }),
    };
  }

  async function writeMcpConfig(): Promise<void> {
    await fs.writeFile(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({ mcpServers: { '@hjewkes/active-work': { type: 'http' } } }),
      'utf8',
    );
  }

  async function writeSkill(): Promise<void> {
    const dir = path.join(homeDir, '.claude', 'skills', 'active-work');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# skill\n', 'utf8');
  }

  it('reports ok when every check passes', async () => {
    await fs.mkdir(homeDir, { recursive: true });
    await writeMcpConfig();
    await writeSkill();
    const report = await runDoctor(healthyDeps());
    expect(report.ok).toBe(true);
    for (const check of report.checks) {
      expect(check.status).toBe('ok');
    }
  });

  it('fails on an outdated Node version', async () => {
    const report = await runDoctor({ ...healthyDeps(), nodeVersion: 'v18.19.0' });
    expect(report.ok).toBe(false);
    expect(statusOf(report.checks, 'node')).toBe('fail');
  });

  it('fails when the active root is missing', async () => {
    const report = await runDoctor({
      ...healthyDeps(),
      activeRoot: path.join(base, 'does-not-exist'),
    });
    expect(report.ok).toBe(false);
    expect(statusOf(report.checks, 'active-root')).toBe('fail');
  });

  it('warns when the active root has no schema version', async () => {
    await fs.rm(path.join(activeRoot, '.schema-version'), { force: true });
    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'active-root')).toBe('warn');
    expect(report.ok).toBe(true); // warnings do not fail the report
  });

  it('warns (not fails) when the daemon is not running', async () => {
    const report = await runDoctor({
      ...healthyDeps(),
      probeDaemon: async () => ({ running: false, healthy: false }),
    });
    expect(statusOf(report.checks, 'daemon')).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('names the port it probed when the daemon is absent', async () => {
    const report = await runDoctor({
      ...healthyDeps(),
      probeDaemon: async () => ({ running: false, healthy: false, port: 7400 }),
    });
    const daemon = report.checks.find((c) => c.name === 'daemon')!;
    expect(daemon.status).toBe('warn');
    expect(daemon.detail).toContain('port 7400');
  });

  it('warns — but reports the daemon running — when it answers with no pid file', async () => {
    const report = await runDoctor({
      ...healthyDeps(),
      probeDaemon: async () => ({
        running: true,
        healthy: true,
        orphaned: true,
        pid: 62800,
        port: 7400,
        version: '0.3.0',
      }),
    });
    const daemon = report.checks.find((c) => c.name === 'daemon')!;
    expect(daemon.status).toBe('warn');
    expect(daemon.detail).toContain('running (pid 62800, port 7400, v0.3.0)');
    expect(daemon.detail).toContain('no pid file');
    expect(report.ok).toBe(true);
  });

  it('warns when the daemon is alive but unhealthy', async () => {
    const report = await runDoctor({
      ...healthyDeps(),
      probeDaemon: async () => ({ running: true, healthy: false, pid: 9 }),
    });
    expect(statusOf(report.checks, 'daemon')).toBe('warn');
  });

  it('warns when the MCP server is not registered', async () => {
    await fs.mkdir(homeDir, { recursive: true });
    await writeSkill(); // skill present, but no .claude.json
    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'mcp-registration')).toBe('warn');
  });

  it('accepts the http `active-work` server name too', async () => {
    await fs.mkdir(homeDir, { recursive: true });
    await writeSkill();
    await fs.writeFile(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'active-work': { type: 'http', url: 'http://127.0.0.1:7400/mcp' } },
      }),
      'utf8',
    );
    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'mcp-registration')).toBe('ok');
  });

  it('warns when the skill is not installed', async () => {
    await fs.mkdir(homeDir, { recursive: true });
    await writeMcpConfig(); // config present, but no skill
    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'skill')).toBe('warn');
  });

  it('warns when a supported supervisor is not active', async () => {
    const report = await runDoctor({
      ...healthyDeps(),
      supervisorActive: async () => ({ kind: 'systemd', active: false }),
    });
    expect(statusOf(report.checks, 'supervision')).toBe('warn');
  });

  it('treats a platform without supervisor integration as ok', async () => {
    const report = await runDoctor({
      ...healthyDeps(),
      supervisorActive: async () => null,
    });
    expect(statusOf(report.checks, 'supervision')).toBe('ok');
  });

  it('reports open-loops ok when there are no initiatives', async () => {
    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'open-loops')).toBe('ok');
  });

  it('warns on a resolves entry pointing at a nonexistent next_step', async () => {
    const initiativeDir = path.join(activeRoot, 'alpha');
    await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', '2026-07-01-s1.md'),
      [
        '---',
        'session_id: s1',
        'started: 2026-07-01T00:00:00Z',
        'ended: 2026-07-01T00:00:00Z',
        'track: canonical',
        'resolves:',
        '  - ref: nope#missing',
        '    outcome: done',
        '---',
        '',
        'narrative',
        '',
      ].join('\n'),
      'utf8',
    );
    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'open-loops')).toBe('warn');
    const check = report.checks.find((c) => c.name === 'open-loops')!;
    expect(check.detail).toContain('alpha/sessions/2026-07-01-s1.md');
    expect(check.detail).toContain('nope#missing');
    expect(check.detail).toContain('no such next_step');
  });

  it('tells a rejected close apart from a bad ref', async () => {
    const initiativeDir = path.join(activeRoot, 'alpha');
    await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
    await writeSessionFile(initiativeDir, '2026-07-01-late.md', [
      'session_id: late',
      'started: 2026-07-01T17:00:00Z',
      'ended: 2026-07-01T17:00:00Z',
      'track: canonical',
      'next_steps:',
      '  - id: n1',
      '    text: from the long worktree',
      '    kind: prose',
    ]);
    await writeSessionFile(initiativeDir, '2026-07-01-early.md', [
      'session_id: early',
      'started: 2026-07-01T16:00:00Z',
      'ended: 2026-07-01T16:00:00Z',
      'track: canonical',
      'resolves:',
      '  - ref: 2026-07-01-late#n1',
      '    outcome: done',
    ]);

    const report = await runDoctor(healthyDeps());
    const check = report.checks.find((c) => c.name === 'open-loops')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('re-file the resolve from a later session');
    expect(check.detail).not.toContain('no such next_step');
  });

  it('reports session files that do not parse', async () => {
    const initiativeDir = path.join(activeRoot, 'alpha');
    await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', 'ARCHIVED-handoff.md'),
      '# hand-placed archive\n',
      'utf8',
    );

    const report = await runDoctor(healthyDeps());
    const check = report.checks.find((c) => c.name === 'session-files')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('alpha/sessions/ARCHIVED-handoff.md');
    expect(check.detail).toContain('no frontmatter block');
  });

  it('reports session-files ok when every session parses', async () => {
    const initiativeDir = path.join(activeRoot, 'alpha');
    await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
    await writeSessionFile(initiativeDir, '2026-07-01-s1.md', [
      'session_id: s1',
      'started: 2026-07-01T00:00:00Z',
      'ended: 2026-07-01T00:00:00Z',
      'track: canonical',
    ]);

    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'session-files')).toBe('ok');
  });

  it('reports task-refs ok when there are no initiatives', async () => {
    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'task-refs')).toBe('ok');
  });

  it('warns when next_steps references a task that does not exist', async () => {
    const initiativeDir = path.join(activeRoot, 'alpha');
    await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
    await writeSessionFile(initiativeDir, '2026-07-01-s1.md', [
      'session_id: s1',
      'started: 2026-07-01T00:00:00Z',
      'ended: 2026-07-01T00:00:00Z',
      'track: canonical',
      'next_steps:',
      '  - id: n1',
      '    text: ship the thing',
      '    kind: task',
      '    ref: AW-999',
    ]);

    const report = await runDoctor(healthyDeps());
    const check = report.checks.find((c) => c.name === 'task-refs')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('alpha/sessions/2026-07-01-s1.md');
    expect(check.detail).toContain('2026-07-01-s1#n1');
    expect(check.detail).toContain('AW-999');
  });

  it('is silent when next_steps references a task that exists but is not done', async () => {
    const initiativeDir = path.join(activeRoot, 'alpha');
    await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(initiativeDir, 'tasks'), { recursive: true });
    await writeSessionFile(initiativeDir, '2026-07-01-s1.md', [
      'session_id: s1',
      'started: 2026-07-01T00:00:00Z',
      'ended: 2026-07-01T00:00:00Z',
      'track: canonical',
      'next_steps:',
      '  - id: n1',
      '    text: ship the thing',
      '    kind: task',
      '    ref: AW-1',
    ]);
    await fs.writeFile(
      path.join(initiativeDir, 'tasks', 'AW-1.yml'),
      [
        'id: AW-1',
        'title: Ship the thing',
        'priority: 1',
        'status: open',
        'created: 2026-07-01',
        'updated: 2026-07-01',
        'done_at: null',
      ].join('\n'),
      'utf8',
    );

    const report = await runDoctor(healthyDeps());
    expect(statusOf(report.checks, 'task-refs')).toBe('ok');
  });

  it('does not confuse a bad task ref with a cross-initiative id', async () => {
    const alphaDir = path.join(activeRoot, 'alpha');
    const betaDir = path.join(activeRoot, 'beta');
    await fs.mkdir(path.join(alphaDir, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(betaDir, 'tasks'), { recursive: true });
    await writeSessionFile(alphaDir, '2026-07-01-s1.md', [
      'session_id: s1',
      'started: 2026-07-01T00:00:00Z',
      'ended: 2026-07-01T00:00:00Z',
      'track: canonical',
      'next_steps:',
      '  - id: n1',
      '    text: cross-initiative reference',
      '    kind: task',
      '    ref: VW-68',
    ]);
    await fs.writeFile(
      path.join(betaDir, 'tasks', 'VW-68.yml'),
      [
        'id: VW-68',
        'title: Lives in beta, not alpha',
        'priority: 1',
        'status: open',
        'created: 2026-07-01',
        'updated: 2026-07-01',
        'done_at: null',
      ].join('\n'),
      'utf8',
    );

    const report = await runDoctor(healthyDeps());
    const check = report.checks.find((c) => c.name === 'task-refs')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('alpha/sessions/2026-07-01-s1.md');
    expect(check.detail).toContain('VW-68');
  });
});

/**
 * The default (uninjected) daemon probe: a missing PID file must not by itself
 * mean "not running" — AW-76 had a live daemon reported as down.
 */
describe('runDoctor default daemon probe', () => {
  let stateRoot: string;
  let activeRoot: string;

  beforeEach(async () => {
    stateRoot = mkdtempSync(path.join(tmpdir(), 'aw-doctor-state-'));
    activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-doctor-active-'));
    await fs.writeFile(path.join(activeRoot, '.schema-version'), '1\n', 'utf8');
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(stateRoot);
    delete process.env.AW_PORT;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(activeRoot, { recursive: true, force: true });
  });

  function depsWithoutProbe(): DoctorDeps {
    // Everything but `probeDaemon` is injected: this exercises the real probe.
    return {
      fs,
      activeRoot,
      homeDir: stateRoot,
      nodeVersion: 'v22.4.0',
      supervisorActive: async () => null,
    };
  }

  it('reports running from /health alone when the PID file is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: '0.3.0', pid: 62800, uptime_ms: 9, port: 7400 }),
      })),
    );
    const report = await runDoctor(depsWithoutProbe());
    const daemon = report.checks.find((c) => c.name === 'daemon')!;
    expect(daemon.status).toBe('warn');
    expect(daemon.detail).toContain('running (pid 62800, port 7400, v0.3.0)');
  });

  it('reports not running when the PID file is gone and nothing answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const report = await runDoctor(depsWithoutProbe());
    const daemon = report.checks.find((c) => c.name === 'daemon')!;
    expect(daemon.status).toBe('warn');
    expect(daemon.detail).toContain('not running (nothing answered port 7400)');
  });
});
