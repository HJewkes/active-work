import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintHashes } from '../../src/lint/hashes.js';
import { recordArtifactHash } from '../../src/utils/artifact-hash.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

describe('lintHashes', () => {
  it('returns no findings when no artifact has ever been CLI-written (no manifest)', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const findings = await lintHashes('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });

  it('returns no findings when on-disk content matches the recorded hash', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const filePath = path.join(dir, 'artifacts.yml');
      const content = await fs.readFile(filePath, 'utf8');
      await recordArtifactHash(dir, 'artifacts.yml', content);

      const findings = await lintHashes('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });

  it('warns when a tracked file has been hand-edited since the last CLI write', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const filePath = path.join(dir, 'artifacts.yml');
      const originalContent = await fs.readFile(filePath, 'utf8');
      await recordArtifactHash(dir, 'artifacts.yml', originalContent);

      await fs.writeFile(filePath, `${originalContent}\n# hand-edited\n`);

      const findings = await lintHashes('sample-initiative', dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        level: 'warn',
        slug: 'sample-initiative',
        file: 'artifacts.yml',
      });
      expect(findings[0].message).toContain('hand-edited outside active-work');
    });
  });

  it('does not flag a manifest entry whose file has since been deleted', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      await recordArtifactHash(dir, 'tasks/GONE.yml', 'id: GONE\n');

      const findings = await lintHashes('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });
});
