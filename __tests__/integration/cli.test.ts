import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import envPaths from 'env-paths';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../../src/session-index/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_BIN = path.join(REPO_ROOT, 'dist', 'cli.js');
const SRC_BIN = path.join(REPO_ROOT, 'src', 'cli.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

interface Runner {
  command: string;
  baseArgs: string[];
}

/**
 * Pick how to invoke the CLI: a pre-built `dist/cli.js` when present, else tsx
 * running the source file. CI builds the CLI before this suite runs (see the
 * "Build CLI" step in ci.yml) so it always takes the deterministic dist path;
 * the tsx fallback is a local-dev convenience for when `pnpm build` hasn't run.
 * Preferring dist avoids cold-tsx transpile variance across processes (AW-12).
 */
function pickRunner(): Runner {
  if (existsSync(DIST_BIN)) {
    return { command: process.execPath, baseArgs: [DIST_BIN] };
  }
  if (existsSync(TSX_BIN) && existsSync(SRC_BIN)) {
    return { command: TSX_BIN, baseArgs: [SRC_BIN] };
  }
  throw new Error(`No CLI runner available. Looked for ${DIST_BIN} and ${TSX_BIN}.`);
}

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

/** A loopback port that was free a moment ago and has nothing listening on it now. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

let runner: Runner;

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync(runner.command, [...runner.baseArgs, ...args], {
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
    runner = pickRunner();
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
    expect(res.stdout).toMatch(/Usage:\s+active-work/);
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

  it('active-work new creates an initiative dir and prints success envelope in --json', async () => {
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

  it('active-work list --json returns a valid success envelope', () => {
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

  it('refuses a session graph from a newer active-work with an upgrade message, not a stack', async () => {
    const graphPath = path.join(activeRoot, '.miner', 'graph.sqlite3');
    const futureVersion = SCHEMA_VERSION + 1;
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    const db = new Database(graphPath);
    db.exec(
      'CREATE TABLE _migration (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO _migration VALUES (?, ?, ?)').run(
      futureVersion,
      'future',
      new Date().toISOString(),
    );
    db.close();

    // A closed port: were the open to succeed, miner status must not reach the operator's daemon.
    const res = runCli(['miner', 'status'], {
      ACTIVE_ROOT: activeRoot,
      AW_PORT: String(await closedPort()),
    });

    expect(res.status).toBe(78);
    expect(res.stderr).toContain(
      `error: session graph ${graphPath} records schema version ${futureVersion}`,
    );
    expect(res.stderr).toContain('Upgrade active-work');
    expect(res.stderr).not.toMatch(/^\s+at /m);
  });

  it('reports the version of the build it is, not a constant', async () => {
    // Through 0.4.0 this answered '0.1.0' from a hardcoded TODO while the
    // installed package was three releases ahead. The daemon runs the installed
    // binary rather than the repo, so this field is how anyone establishes which
    // build is live — a constant cannot answer it.
    const { status, stdout } = runCli(['--version']);
    const reported = stdout.trim();

    expect(status).toBe(0);
    if (existsSync(DIST_BIN)) {
      // tsup substitutes the define, so a built bundle must match package.json.
      const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        version: string;
      };
      expect(reported).toBe(pkg.version);
    } else {
      // Unbuilt tree under tsx: visibly not a release, rather than a stale number.
      expect(reported).toBe('0.0.0-dev');
    }
  });

  it('opens a loop outside wrap, lists it as due, and refuses to resolve it twice', () => {
    const env = { ACTIVE_ROOT: activeRoot };
    const slug = 'loop-demo';
    runCli(['new', slug, '--title', 'Loop demo', '--ship-target', '2026-Q3'], env);

    const opened = runCli(
      [
        '--json',
        'loop',
        'open',
        slug,
        '--text',
        'Restore the pool',
        '--due',
        '2026-01-01T00:00:00Z',
      ],
      env,
    );
    expect(opened.status).toBe(0);
    const { ref } = (JSON.parse(opened.stdout) as { data: { ref: string } }).data;

    const due = runCli(['--json', 'loops', slug, '--due'], env);
    const listed = JSON.parse(due.stdout) as {
      data: { open: Array<{ ref: string; trigger_met?: string[] }> };
    };
    expect(listed.data.open).toMatchObject([{ ref, trigger_met: ['due'] }]);

    expect(runCli(['loop', 'resolve', slug, ref], env).status).toBe(0);
    const again = runCli(['loop', 'resolve', slug, ref], env);
    expect(again.status).toBe(65);
    expect(again.stderr).toMatch(/already closed: done/);
    expect(runCli(['--json', 'loops', slug, '--due'], env).stdout).toContain('"open":[]');
  });

  describe('task edit flags', () => {
    const SLUG = 'flag-demo';
    let taskId: string;

    const taskEdit = (...args: string[]): RunResult =>
      runCli(['--json', 'task', 'edit', SLUG, taskId, ...args], { ACTIVE_ROOT: activeRoot });

    const readTaskFile = (): Promise<string> =>
      fs.readFile(path.join(activeRoot, SLUG, 'tasks', `${taskId}.yml`), 'utf8');

    beforeEach(() => {
      const env = { ACTIVE_ROOT: activeRoot };
      runCli(['new', SLUG, '--title', 'Flag demo', '--ship-target', '2026-Q3'], env);
      const added = runCli(
        [
          '--json',
          'task',
          'add',
          SLUG,
          '--title',
          'Demo',
          '--tags',
          'alpha,beta',
          '--notes',
          'One',
        ],
        env,
      );
      taskId = (JSON.parse(added.stdout) as { data: { id: string } }).data.id;
    });

    it('appends a line that starts with a dash and adds a tag in one call', () => {
      const res = taskEdit('--append', '- item: "two" # kept', '--add-tag', 'gamma');

      expect(res.status).toBe(0);
      const { data } = JSON.parse(res.stdout) as { data: { notes: string; tags: string[] } };
      expect(data.notes).toBe('One\n- item: "two" # kept');
      expect(data.tags).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('exits 0 and reports the no-op when the tag is already present', async () => {
      const before = await readTaskFile();

      const res = taskEdit('--add-tag', 'alpha');

      expect(res.status).toBe(0);
      const { warnings } = JSON.parse(res.stdout) as { warnings: string[] };
      expect(warnings).toEqual(['Tag already present, nothing added: alpha']);
      expect(await readTaskFile()).toBe(before);
    });

    it('refuses a four-argument tags edit that drops a tag unless --force is passed', async () => {
      const before = await readTaskFile();

      const res = taskEdit('tags', 'x, y');

      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toContain('--force');
      expect(await readTaskFile()).toBe(before);
    });

    it('still replaces a whole field with the four-argument form', () => {
      const res = taskEdit('tags', 'x, y', '--force');

      expect(res.status).toBe(0);
      const { data } = JSON.parse(res.stdout) as { data: { tags: string[] } };
      expect(data.tags).toEqual(['x', 'y']);
    });

    it.each([
      ['the field form mixed with a flag', ['notes', 'Two', '--append', 'Three'], /not both/],
      ['no operation', [], /Nothing to edit/],
      ['a field without a value', ['notes'], /needs both <field> and <value>/],
      ['an empty --append', ['--append', ''], /non-empty text/],
    ])('exits 64 and leaves the file untouched for %s', async (_label, args, message) => {
      const before = await readTaskFile();

      const res = taskEdit(...args);

      expect(res.status).toBe(64);
      expect(res.stdout).toMatch(message);
      expect(await readTaskFile()).toBe(before);
    });
  });

  describe('task --quiet', () => {
    const SLUG = 'quiet-demo';
    const env = (): Record<string, string> => ({ ACTIVE_ROOT: activeRoot });

    beforeEach(() => {
      runCli(['new', SLUG, '--title', 'Quiet demo', '--ship-target', '2026-Q3'], env());
    });

    it('task add --quiet prints "<id> created"', () => {
      const res = runCli(['task', 'add', SLUG, '--title', 'Demo', '--quiet'], env());

      expect(res.status).toBe(0);
      expect(res.stdout).toBe('QD-1 created\n');
    });

    it('task edit --quiet prints "<id> edited: <what>"', () => {
      runCli(['task', 'add', SLUG, '--title', 'Demo', '--quiet'], env());

      const res = runCli(['task', 'edit', SLUG, 'QD-1', '--append', 'Two', '--quiet'], env());

      expect(res.status).toBe(0);
      expect(res.stdout).toBe('QD-1 edited: notes\n');
    });

    it('task done --quiet prints "<id> done <date>"', () => {
      runCli(['task', 'add', SLUG, '--title', 'Demo', '--quiet'], env());

      const res = runCli(['task', 'done', SLUG, 'QD-1', '--quiet'], env());

      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/^QD-1 done \d{4}-\d{2}-\d{2}\n$/);
    });

    it('exits 64 and writes nothing for --quiet with --json', async () => {
      const res = runCli(['--json', 'task', 'add', SLUG, '--title', 'Demo', '--quiet'], env());

      expect(res.status).toBe(64);
      expect(res.stdout).toContain('--quiet and --json cannot be combined');
      await expect(fs.readdir(path.join(activeRoot, SLUG, 'tasks'))).resolves.toEqual([]);
    });
  });
});
