import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  readFrontmatter,
  readRawFrontmatter,
  writeFrontmatter,
} from '../../src/utils/gray-matter-io.js';

const Schema = z.object({
  title: z.string(),
  state: z.enum(['focused', 'paused']),
  rank: z.number().int().optional(),
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-gray-matter-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('gray-matter round-trip', () => {
  it('preserves frontmatter and body', async () => {
    const target = path.join(dir, 'brief.md');
    const frontmatter = { title: 'Demo', state: 'focused' as const, rank: 1 };
    const body = '# Heading\n\nSome prose with --- and other tricky bits.\n';
    await writeFrontmatter(target, frontmatter, body, Schema);

    const loaded = await readFrontmatter(target, Schema);
    expect(loaded.frontmatter).toEqual(frontmatter);
    expect(loaded.body.trim()).toBe(body.trim());
  });

  it('rejects writes whose frontmatter fails the schema', async () => {
    const target = path.join(dir, 'invalid.md');
    await expect(
      // @ts-expect-error – exercising runtime guard
      writeFrontmatter(target, { title: 'x', state: 'wrong' }, 'body', Schema),
    ).rejects.toThrow(/Frontmatter validation failed/);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('rejects reads whose frontmatter fails the schema', async () => {
    const target = path.join(dir, 'broken.md');
    await fs.writeFile(target, '---\ntitle: 1\nstate: nope\n---\nbody\n');
    await expect(readFrontmatter(target, Schema)).rejects.toThrow(
      /Frontmatter validation failed/,
    );
  });
});

describe('readRawFrontmatter', () => {
  it('returns invalid frontmatter without validating it', async () => {
    const target = path.join(dir, 'raw.md');
    await fs.writeFile(target, '---\ntitle: 7\nstate: bogus\nextra: stuff\n---\nhello\n');
    const { frontmatter, body } = await readRawFrontmatter(target);
    expect(frontmatter).toEqual({ title: 7, state: 'bogus', extra: 'stuff' });
    expect(body.trim()).toBe('hello');
  });

  it('handles files without frontmatter', async () => {
    const target = path.join(dir, 'plain.md');
    await fs.writeFile(target, '# just body\n');
    const { frontmatter, body } = await readRawFrontmatter(target);
    expect(frontmatter).toEqual({});
    expect(body).toContain('# just body');
  });
});
