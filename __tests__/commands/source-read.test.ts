import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import sourceReadCmd from '../../src/commands/source-read.js';
import { MAX_READ_BYTES } from '../../src/sources/read.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const ctx = { activeRoot: '', warnings: [], format: 'json' as const };

async function writeSource(root: string, name: string, body: string | Buffer): Promise<string> {
  const dir = path.join(root, SLUG, 'sources');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, body);
  return file;
}

async function writeOutsideSecret(root: string): Promise<string> {
  const secret = path.join(root, 'secret.md');
  await fs.writeFile(secret, '# not yours\n', 'utf8');
  return secret;
}

describe('source.read', () => {
  it('returns the full text of a markdown source in every path form a caller holds', async () => {
    await withTempActiveRoot(async (root) => {
      const body = '# Furnace\n\nFilter is 16x25x1.\n';
      const absolute = await writeSource(root, 'deepdive-furnace.md', body);

      const forms = [
        absolute,
        `${SLUG}/sources/deepdive-furnace.md`,
        'sources/deepdive-furnace.md',
      ];
      for (const form of forms) {
        const res = await sourceReadCmd.run({ slug: SLUG, path: form }, ctx);
        expect(res).toEqual({
          path: 'sources/deepdive-furnace.md',
          content: body,
          truncated: false,
          bytes: Buffer.byteLength(body),
        });
      }
    });
  });

  it('refuses a relative path that climbs out of the initiative', async () => {
    await withTempActiveRoot(async (root) => {
      await writeOutsideSecret(root);
      await expect(
        sourceReadCmd.run({ slug: SLUG, path: 'sources/../../secret.md' }, ctx),
      ).rejects.toThrow(/outside the initiative/);
    });
  });

  it('refuses an absolute path to a file outside the initiative', async () => {
    await withTempActiveRoot(async (root) => {
      const secret = await writeOutsideSecret(root);
      await expect(sourceReadCmd.run({ slug: SLUG, path: secret }, ctx)).rejects.toThrow(
        /outside the initiative/,
      );
    });
  });

  it('refuses a symlink inside the initiative that points outside it', async () => {
    await withTempActiveRoot(async (root) => {
      const secret = await writeOutsideSecret(root);
      const link = path.join(root, SLUG, 'docs');
      await fs.symlink(path.dirname(secret), link);
      await expect(sourceReadCmd.run({ slug: SLUG, path: 'docs/secret.md' }, ctx)).rejects.toThrow(
        /outside the initiative/,
      );
    });
  });

  it('refuses a slug that is itself a traversal', async () => {
    await withTempActiveRoot(async (root) => {
      await writeOutsideSecret(root);
      await expect(sourceReadCmd.run({ slug: '..', path: 'secret.md' }, ctx)).rejects.toThrow(
        /Invalid slug/,
      );
    });
  });

  it('refuses a binary source and names its type', async () => {
    await withTempActiveRoot(async (root) => {
      await writeSource(root, 'manual.pdf', Buffer.from('%PDF-1.7\n\0\0binary'));
      await expect(
        sourceReadCmd.run({ slug: SLUG, path: 'sources/manual.pdf' }, ctx),
      ).rejects.toThrow(/'\.pdf'/);
    });
  });

  it('returns only the head of an oversized file and flags it truncated', async () => {
    await withTempActiveRoot(async (root) => {
      const size = MAX_READ_BYTES + 1024;
      await writeSource(root, 'huge.txt', 'a'.repeat(size));

      const res = await sourceReadCmd.run({ slug: SLUG, path: 'sources/huge.txt' }, ctx);

      expect(res.truncated).toBe(true);
      expect(res.bytes).toBe(size);
      expect(res.content).toHaveLength(MAX_READ_BYTES);
    });
  });
});
