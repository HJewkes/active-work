import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { runDoctor, type DoctorDeps, type DoctorCheck } from '../src/doctor.js';

function statusOf(checks: DoctorCheck[], name: string): string {
  return checks.find((c) => c.name === name)!.status;
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
});
