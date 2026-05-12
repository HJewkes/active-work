import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintHandoff } from '../../src/lint/handoff.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

describe('lintHandoff', () => {
  it('returns no findings when handoff is below the limit', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const findings = await lintHandoff('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });

  it('returns no findings when handoff.md is absent', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      await fs.rm(path.join(dir, 'handoff.md'));
      const findings = await lintHandoff('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });

  it('warns when body exceeds the configured cap', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const bigBody = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
      await fs.writeFile(path.join(dir, 'handoff.md'), bigBody + '\n', 'utf8');
      const findings = await lintHandoff('sample-initiative', dir, {
        handoffMaxBodyLines: 10,
        briefMaxBodyLines: 150,
        taskNotesMaxLines: 30,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        level: 'warn',
        slug: 'sample-initiative',
        file: 'handoff.md',
      });
      expect(findings[0].message).toContain('body is 12 lines (> 10)');
      expect(findings[0].message).toContain('sources/');
    });
  });

  it('ignores trailing whitespace-only lines when counting', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const body = 'one\ntwo\nthree\n\n   \n\n';
      await fs.writeFile(path.join(dir, 'handoff.md'), body, 'utf8');
      const findings = await lintHandoff('sample-initiative', dir, {
        handoffMaxBodyLines: 3,
        briefMaxBodyLines: 150,
        taskNotesMaxLines: 30,
      });
      expect(findings).toEqual([]);
    });
  });
});
