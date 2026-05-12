import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readYaml, writeYaml } from '../../src/utils/yaml-io.js';

const Schema = z.object({
  title: z.string(),
  count: z.number().int(),
  tags: z.array(z.string()),
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-yaml-io-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('yaml round-trip', () => {
  it('preserves the data shape across write/read', async () => {
    const target = path.join(dir, 'data.yml');
    const data = { title: 'hello', count: 3, tags: ['a', 'b'] };
    await writeYaml(target, data, Schema);
    const loaded = await readYaml(target, Schema);
    expect(loaded).toEqual(data);
  });

  it('rejects writes that do not satisfy the schema', async () => {
    const target = path.join(dir, 'bad.yml');
    // @ts-expect-error – exercising runtime guard
    await expect(writeYaml(target, { title: 1 }, Schema)).rejects.toThrow(
      /Schema validation failed/,
    );
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('rejects reads that do not satisfy the schema', async () => {
    const target = path.join(dir, 'invalid.yml');
    await fs.writeFile(target, 'title: 42\n');
    await expect(readYaml(target, Schema)).rejects.toThrow(/Schema validation failed/);
  });

  it('reports parse errors with the file path', async () => {
    const target = path.join(dir, 'broken.yml');
    await fs.writeFile(target, 'title: : :\n  - bad\n');
    await expect(readYaml(target, Schema)).rejects.toThrow(/broken\.yml/);
  });
});
