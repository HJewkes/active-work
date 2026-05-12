import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { appendUsage } from '../../src/utils/usage-log.js';
import * as paths from '../../src/utils/paths.js';

describe('appendUsage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-usage-log-'));
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('appends a single JSONL line', async () => {
    await appendUsage({
      ts: '2026-05-12T12:34:56.000Z',
      command: 'new',
      success: true,
      exit_code: 0,
    });

    const raw = await fs.readFile(path.join(tempDir, 'usage.jsonl'), 'utf8');
    expect(raw).toBe(
      JSON.stringify({
        ts: '2026-05-12T12:34:56.000Z',
        command: 'new',
        success: true,
        exit_code: 0,
      }) + '\n',
    );
  });

  it('appends multiple lines in order', async () => {
    await appendUsage({ ts: 't1', command: 'a', success: true, exit_code: 0 });
    await appendUsage({ ts: 't2', command: 'b', success: false, exit_code: 64 });
    await appendUsage({ ts: 't3', command: 'c', success: true, exit_code: 0 });

    const raw = await fs.readFile(path.join(tempDir, 'usage.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).command).toBe('a');
    expect(JSON.parse(lines[1]!).command).toBe('b');
    expect(JSON.parse(lines[2]!).command).toBe('c');
  });

  it('silently swallows errors when the state dir is unwriteable', async () => {
    // Point the state root at an existing regular file so mkdir/append fail.
    const file = path.join(tempDir, 'sentinel');
    await fs.writeFile(file, 'x');
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(path.join(file, 'nested'));

    await expect(
      appendUsage({ ts: 't', command: 'x', success: true, exit_code: 0 }),
    ).resolves.toBeUndefined();
  });
});
