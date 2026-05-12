import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintBrief } from '../../src/lint/brief.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

describe('lintBrief', () => {
  it('returns no findings on the fixture (small body)', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const findings = await lintBrief('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });

  it('returns no findings when brief.md is absent', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      await fs.rm(path.join(dir, 'brief.md'));
      const findings = await lintBrief('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });

  it('warns when prose body exceeds the cap', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const frontmatter = ['---', 'schema_version: 1', 'title: Big', 'state: focused', '---'];
      const body = Array.from({ length: 20 }, (_, i) => `prose line ${i + 1}`);
      await fs.writeFile(
        path.join(dir, 'brief.md'),
        [...frontmatter, ...body, ''].join('\n'),
        'utf8',
      );
      const findings = await lintBrief('sample-initiative', dir, {
        handoffMaxBodyLines: 100,
        briefMaxBodyLines: 10,
        taskNotesMaxLines: 30,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        level: 'warn',
        slug: 'sample-initiative',
        file: 'brief.md',
      });
      expect(findings[0].message).toMatch(/body is \d+ lines \(> 10\)/);
    });
  });

  it('still lints when frontmatter is schema-invalid', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const body = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
      const content = `---\nbogus: true\n---\n${body}\n`;
      await fs.writeFile(path.join(dir, 'brief.md'), content, 'utf8');
      const findings = await lintBrief('sample-initiative', dir, {
        handoffMaxBodyLines: 100,
        briefMaxBodyLines: 5,
        taskNotesMaxLines: 30,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('body is 8 lines (> 5)');
    });
  });
});
