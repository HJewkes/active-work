import { promises as fs, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readArtifactHashes } from '../../src/utils/artifact-hash.js';
import {
  parseFrontmatter,
  readFrontmatter,
  readRawFrontmatter,
  stringifyFrontmatter,
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
    await expect(readFrontmatter(target, Schema)).rejects.toThrow(/Frontmatter validation failed/);
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

describe('artifact hash tracking (AW-66)', () => {
  it('records a hash when writing brief.md', async () => {
    const target = path.join(dir, 'brief.md');
    await writeFrontmatter(target, { title: 'Demo', state: 'focused' as const }, 'body', Schema);
    const manifest = await readArtifactHashes(dir);
    expect(manifest['brief.md']).toBeDefined();
  });

  it('leaves no manifest side effect for a session-shaped path', async () => {
    const sessionsDir = path.join(dir, 'sessions');
    await fs.mkdir(sessionsDir);
    const target = path.join(sessionsDir, '2026-07-30-a.md');
    await writeFrontmatter(target, { title: 'Demo', state: 'focused' as const }, 'body', Schema);
    const manifest = await readArtifactHashes(dir);
    expect(manifest).toEqual({});
  });
});

describe('executable frontmatter (TP-1007)', () => {
  const probe = globalThis as Record<string, unknown>;

  afterEach(() => {
    delete probe.__awMatterProbe;
  });

  it.each(['js', 'javascript', 'JS', 'coffee'])('refuses ---%s without running it', (lang) => {
    const raw = `---${lang}\n{ title: (globalThis.__awMatterProbe = 42) }\n---\nbody\n`;

    expect(() => parseFrontmatter(raw)).toThrow(/Invalid frontmatter: language .* is not allowed/);
    expect(probe.__awMatterProbe).toBeUndefined();
  });

  it('refuses an unknown frontmatter language', () => {
    expect(() => parseFrontmatter('---constructor\nx\n---\nbody\n')).toThrow(/not allowed/);
  });

  it('reports a ---js file as invalid frontmatter on read', async () => {
    const target = path.join(dir, 'js.md');
    await fs.writeFile(target, '---js\n{ title: (globalThis.__awMatterProbe = 42) }\n---\nbody\n');

    await expect(readFrontmatter(target, Schema)).rejects.toThrow(/Invalid frontmatter/);
    await expect(readRawFrontmatter(target)).rejects.toThrow(/Invalid frontmatter/);
    expect(probe.__awMatterProbe).toBeUndefined();
  });

  it('does not run a ---js block at the start of a body being written', () => {
    const body = '---js\n{ title: (globalThis.__awMatterProbe = 42) }\n---\nrest\n';

    expect(() => stringifyFrontmatter(body, { title: 'x' })).toThrow(/not allowed/);
    expect(probe.__awMatterProbe).toBeUndefined();
  });

  it('still parses yaml and json frontmatter', () => {
    expect(parseFrontmatter('---\ntitle: Y\n---\nb\n').data).toEqual({ title: 'Y' });
    expect(parseFrontmatter('---json\n{"title": "J"}\n---\nb\n').data).toEqual({ title: 'J' });
  });
});

describe('gray-matter import boundary', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const helper = path.join('src', 'utils', 'gray-matter-io.ts');
  const importsGrayMatter = /(?:from|import\(|require\()\s*['"]gray-matter['"]/;

  function sourceFiles(dirName: string): string[] {
    return readdirSync(path.join(repoRoot, dirName), { recursive: true, encoding: 'utf8' })
      .filter((rel) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(rel) && !rel.includes('node_modules'))
      .map((rel) => path.join(dirName, rel));
  }

  it('imports gray-matter only from the safe helper', () => {
    const offenders = ['src', '__tests__', 'scripts']
      .flatMap(sourceFiles)
      .filter((rel) => rel !== helper)
      .filter((rel) => importsGrayMatter.test(readFileSync(path.join(repoRoot, rel), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
