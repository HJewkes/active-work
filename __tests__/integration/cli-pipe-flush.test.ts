import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeToRemove } from '../setup/test-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_BIN = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');

const SLUG = 'scout';
const TASK_COUNT = 1500;
const ONE_MB = 1024 * 1024;
const READ_DELAY_MS = 10;

let tempDir: string;
let env: NodeJS.ProcessEnv;

function writeTasks(tasksDir: string): void {
  const notes = 'agent-x reported seat-x progress on the synthetic workload. '.repeat(12);
  for (let i = 1; i <= TASK_COUNT; i++) {
    const yaml = [
      `id: S-${i}`,
      `title: Synthetic task ${i} for seat-x`,
      `priority: ${i}`,
      'status: open',
      'notes: |',
      `  ${notes}`,
      'created: 2026-01-01',
      'updated: 2026-01-01',
      'done_at: null',
      '',
    ].join('\n');
    writeFileSync(path.join(tasksDir, `S-${i}.yml`), yaml);
  }
}

const listArgs = [DIST_BIN, '--json', 'task', 'list', SLUG];

/** The reference output: stdout to a file, which Node writes synchronously. */
function listToFile(): Buffer {
  const outFile = path.join(tempDir, 'list.json');
  const fd = openSync(outFile, 'w');
  try {
    const res = spawnSync(process.execPath, listArgs, { env, stdio: ['ignore', fd, 'pipe'] });
    expect(res.status).toBe(0);
  } finally {
    closeSync(fd);
  }
  return readFileSync(outFile);
}

/** stdout to a pipe whose reader pauses after every chunk, like a busy `jq`. */
function listToSlowPipe(): Promise<{ status: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, listArgs, { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), READ_DELAY_MS);
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(chunks) }));
  });
}

/** stdout to a reader that closes after the first chunk, like `| head -c 10`. */
function listToClosingPipe(): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, listArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdout.once('data', () => child.stdout.destroy());
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

describe('cli output to a pipe', () => {
  beforeAll(() => {
    if (!existsSync(DIST_BIN)) {
      throw new Error(`Built CLI missing at ${DIST_BIN}; run \`pnpm build:cli\` first.`);
    }
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
    const activeRoot = path.join(tempDir, 'root');
    const home = path.join(tempDir, 'home');
    mkdirSync(activeRoot);
    mkdirSync(home);
    env = { ...process.env, NO_COLOR: '1', ACTIVE_ROOT: activeRoot, HOME: home };
    env.XDG_STATE_HOME = path.join(home, 'state');
    const created = spawnSync(process.execPath, [DIST_BIN, 'new', SLUG, '--title', 'Scout'], {
      env,
    });
    expect(created.status).toBe(0);
    writeTasks(path.join(activeRoot, SLUG, 'tasks'));
  });

  afterAll(() => {
    assertSafeToRemove(tempDir);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('delivers the whole result to a slow pipe reader before exiting', async () => {
    const reference = listToFile();
    expect(reference.length).toBeGreaterThan(ONE_MB);

    const piped = await listToSlowPipe();

    expect(piped.status).toBe(0);
    expect(piped.stdout.length).toBe(reference.length);
    const parsed = JSON.parse(piped.stdout.toString('utf8')) as {
      ok: boolean;
      data: { tasks: unknown[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.tasks).toHaveLength(TASK_COUNT);
  });

  it('stops quietly when the reader closes the pipe early', async () => {
    const result = await listToClosingPipe();

    expect(result.stderr).not.toMatch(/EPIPE/);
    expect(result.status).toBe(0);
  });
});
