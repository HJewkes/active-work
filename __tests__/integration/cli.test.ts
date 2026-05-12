import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import envPaths from 'env-paths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_BIN = path.join(REPO_ROOT, 'dist', 'cli.js');

/**
 * Locate the directory where `appendUsage` writes — derived the same way
 * the production code derives it (env-paths "log"). We piggyback on a
 * scratch HOME so the test never touches the operator's real state dir.
 */
function usageLogPathFor(home: string, xdgState: string): string {
  const env = { HOME: home, XDG_STATE_HOME: xdgState };
  const original = { ...process.env };
  try {
    Object.assign(process.env, env);
    const p = envPaths('active-work', { suffix: '' });
    return path.join(p.log, 'usage.jsonl');
  } finally {
    process.env = original;
  }
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
): RunResult {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('cli integration', () => {
  beforeAll(() => {
    if (!existsSync(CLI_BIN)) {
      throw new Error(
        `dist/cli.js missing at ${CLI_BIN}. Run \`pnpm build\` before integration tests.`,
      );
    }
  });

  let activeRoot: string;
  let stateHome: string;
  let homeDir: string;

  beforeEach(() => {
    activeRoot = mkdtempSync(path.join(os.tmpdir(), 'aw-cli-active-'));
    stateHome = mkdtempSync(path.join(os.tmpdir(), 'aw-cli-state-'));
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'aw-cli-home-'));
  });

  afterEach(() => {
    rmSync(activeRoot, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('prints help and exits 0 for --help', () => {
    const res = runCli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Usage:\s+aw/);
    expect(res.stdout).toMatch(/active-work CLI/);
  });

  it('exits with USAGE (64) for an unknown command', () => {
    const res = runCli(['nonexistent-command']);
    expect(res.status).toBe(64);
  });

  it('exits 64 with a clear error when a required option is missing', () => {
    const res = runCli(['new', 'my-slug'], { ACTIVE_ROOT: activeRoot });
    expect(res.status).toBe(64);
    expect(res.stderr).toMatch(/--title/);
  });

  it('aw new creates an initiative dir and prints success envelope in --json', async () => {
    const res = runCli(
      ['--json', 'new', 'my-test-slug', '--title', 'Test', '--ship-target', '2026-Q3'],
      { ACTIVE_ROOT: activeRoot },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { slug: string; dir: string; rank: number; task_prefix: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.slug).toBe('my-test-slug');
    expect(parsed.data.dir).toBe(path.join(activeRoot, 'my-test-slug'));
    expect(parsed.data.rank).toBe(1);
    expect(parsed.data.task_prefix).toBe('MTS');
    const stat = await fs.stat(path.join(activeRoot, 'my-test-slug'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('aw list --json returns a valid success envelope', () => {
    const res = runCli(['--json', 'list'], { ACTIVE_ROOT: activeRoot });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      data: { sections: Array<{ heading: string; items: unknown[] }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.sections.map((s) => s.heading)).toEqual([
      'Focused',
      'Backburner',
      'Paused',
      'Done',
    ]);
  });

  it('writes a structured line to usage.jsonl on every invocation', async () => {
    const logPath = usageLogPathFor(homeDir, stateHome);
    const res = runCli(['--json', 'list'], {
      ACTIVE_ROOT: activeRoot,
      XDG_STATE_HOME: stateHome,
      HOME: homeDir,
    });
    expect(res.status).toBe(0);

    const raw = await fs.readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1]!) as {
      command: string;
      success: boolean;
      exit_code: number;
      ts: string;
      duration_ms: number;
    };
    expect(last.command).toBe('list');
    expect(last.success).toBe(true);
    expect(last.exit_code).toBe(0);
    expect(typeof last.ts).toBe('string');
    expect(typeof last.duration_ms).toBe('number');
  });
});
