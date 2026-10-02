import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { describe, expect, it } from 'vitest';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_BIN = path.join(REPO_ROOT, 'dist', 'cli.js');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const SRC_BIN = path.join(REPO_ROOT, 'src', 'cli.ts');
const WRITERS = 12;
const HOLD_MS = 1_500;

function cliArgv(args: string[]): [string, string[]] {
  if (existsSync(DIST_BIN)) return [process.execPath, [DIST_BIN, ...args]];
  return [TSX_BIN, [SRC_BIN, ...args]];
}

function cliEnv(activeRoot: string): NodeJS.ProcessEnv {
  return { ...process.env, ACTIVE_ROOT: activeRoot, NO_COLOR: '1' };
}

function runCliSync(activeRoot: string, args: string[]): void {
  const [command, argv] = cliArgv(args);
  const result = spawnSync(command, argv, { encoding: 'utf8', env: cliEnv(activeRoot) });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}`);
}

function runCli(activeRoot: string, args: string[]): Promise<{ status: number; stderr: string }> {
  const [command, argv] = cliArgv(args);
  return new Promise((resolve) => {
    const child = spawn(command, argv, { env: cliEnv(activeRoot) });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (status) => resolve({ status: status ?? -1, stderr }));
  });
}

describe('task edit under concurrent writers', () => {
  it('keeps every --append line when 12 processes queue behind a held lock', async () => {
    await withEmptyActiveRoot(async (root) => {
      // Arrange
      runCliSync(root, ['new', 'demo', '--title', 'Demo']);
      runCliSync(root, ['task', 'add', 'demo', '--title', 'Shared task']);
      const release = await lockfile.lock(path.join(root, 'demo', '.lock'), { realpath: false });
      const lines = Array.from({ length: WRITERS }, (_, i) => `note-${i}-end`);

      // Act
      const runs = lines.map((line) =>
        runCli(root, ['task', 'edit', 'demo', 'D-1', '--append', line]),
      );
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      await release();
      const results = await Promise.all(runs);

      // Assert
      expect(results.filter((r) => r.status !== 0)).toEqual([]);
      const yaml = await fs.readFile(path.join(root, 'demo', 'tasks', 'D-1.yml'), 'utf8');
      for (const line of lines) expect(yaml).toContain(line);
    });
  });
});
