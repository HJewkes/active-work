import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite, withFileLock } from '../../src/utils/fs-atomic.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-fs-atomic-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWrite', () => {
  it('writes the content to the target path', async () => {
    const target = path.join(dir, 'out.txt');
    await atomicWrite(target, 'hello world');
    expect(await fs.readFile(target, 'utf8')).toBe('hello world');
  });

  it('reports a clear error when the parent directory is missing', async () => {
    const target = path.join(dir, 'missing-subdir', 'out.txt');
    await expect(atomicWrite(target, 'data')).rejects.toThrow(/ENOENT/);
  });

  it('does not leave temp files behind on success', async () => {
    const target = path.join(dir, 'clean.txt');
    await atomicWrite(target, 'first');
    const remaining = await fs.readdir(dir);
    expect(remaining).toEqual(['clean.txt']);
  });

  it('survives 10 concurrent writes without producing corrupt content', async () => {
    const target = path.join(dir, 'concurrent.txt');
    const payloads = Array.from({ length: 10 }, (_, i) => `payload-${i}`.padEnd(64, '#'));

    await Promise.all(payloads.map((payload) => atomicWrite(target, payload)));

    const final = await fs.readFile(target, 'utf8');
    expect(payloads).toContain(final);

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['concurrent.txt']);
  });
});

describe('withFileLock', () => {
  it('serializes concurrent callers', async () => {
    const lockTarget = path.join(dir, 'serial.lock');
    const events: string[] = [];
    let counter = 0;

    const run = (id: string) =>
      withFileLock(lockTarget, async () => {
        const entered = ++counter;
        events.push(`enter:${id}:${entered}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        const exited = counter;
        events.push(`exit:${id}:${exited}`);
        // counter must not have advanced while we were inside the critical section
        expect(exited).toBe(entered);
        return id;
      });

    await Promise.all([run('a'), run('b'), run('c')]);

    // Each caller's enter and exit must be adjacent in the log.
    for (let i = 0; i < events.length; i += 2) {
      const enter = events[i]!.split(':');
      const exit = events[i + 1]!.split(':');
      expect(enter[0]).toBe('enter');
      expect(exit[0]).toBe('exit');
      expect(enter[1]).toBe(exit[1]);
      expect(enter[2]).toBe(exit[2]);
    }
  });

  it('releases the lock when the body throws', async () => {
    const lockTarget = path.join(dir, 'throws.lock');

    await expect(
      withFileLock(lockTarget, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const result = await withFileLock(lockTarget, async () => 'second');
    expect(result).toBe('second');
  });
});
