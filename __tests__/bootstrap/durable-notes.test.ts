import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assembleBootstrap } from '../../src/bootstrap/prompt.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const NOW = new Date('2026-07-28T12:00:00Z');
const offlineOpts = { includeLiveStatus: false, now: NOW } as const;

async function writeNote(root: string, filename: string, contents: string): Promise<void> {
  const dir = path.join(root, SLUG, 'sources', 'notes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), contents, 'utf8');
}

function noteFixture(kind: string, title: string, created: string): string {
  return `---\nkind: ${kind}\ntitle: ${title}\ncreated: '${created}'\n---\n\nbody\n`;
}

describe('bootstrap durable notes', () => {
  it('omits the section when sources/notes is absent', async () => {
    await withTempActiveRoot(async (root) => {
      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });
      expect(prompt).not.toContain('# Durable notes');
    });
  });

  it('renders one compact line per note, newest first', async () => {
    await withTempActiveRoot(async (root) => {
      await writeNote(
        root,
        '2026-01-02-old-lesson.md',
        noteFixture('process', 'Old lesson', '2026-01-02'),
      );
      await writeNote(
        root,
        '2026-07-01-fresh-gotcha.md',
        noteFixture('gotcha', 'Fresh gotcha', '2026-07-01'),
      );

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      expect(prompt).toContain('# Durable notes (2)');
      expect(prompt).toContain('- [gotcha] Fresh gotcha (2026-07-01)');
      expect(prompt).toContain('- [process] Old lesson (2026-01-02)');
      expect(prompt.indexOf('Fresh gotcha')).toBeLessThan(prompt.indexOf('Old lesson'));
    });
  });

  it('keeps notes far older than the recently-done window', async () => {
    await withTempActiveRoot(async (root) => {
      await writeNote(
        root,
        '2024-03-04-ancient.md',
        noteFixture('decision', 'Ancient decision', '2024-03-04'),
      );

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });
      expect(prompt).toContain('- [decision] Ancient decision (2024-03-04)');
    });
  });

  it('caps the list and reports the overflow', async () => {
    await withTempActiveRoot(async (root) => {
      for (let i = 1; i <= 15; i++) {
        const day = String(i).padStart(2, '0');
        await writeNote(
          root,
          `2026-06-${day}-note-${day}.md`,
          noteFixture('fyi', `Note ${day}`, `2026-06-${day}`),
        );
      }

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      expect(prompt).toContain('# Durable notes (newest 12 of 15)');
      expect(prompt).toContain('- [fyi] Note 15 (2026-06-15)');
      expect(prompt).not.toContain('Note 03 (2026-06-03)');
      expect(prompt).toContain(`(+3 older — \`active-work note list ${SLUG}\`)`);
    });
  });

  it('reports unreadable note files rather than dropping them silently', async () => {
    await withTempActiveRoot(async (root) => {
      await writeNote(root, '2026-06-01-bad.md', '---\nkind: mystery\n---\nnope\n');

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });
      expect(prompt).toContain('# Durable notes (0)');
      expect(prompt).toContain('1 note file(s) unreadable');
    });
  });

  it('places the section after tasks and before open artifacts', async () => {
    await withTempActiveRoot(async (root) => {
      await writeNote(
        root,
        '2026-06-01-placement.md',
        noteFixture('fyi', 'Placement', '2026-06-01'),
      );

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        ...offlineOpts,
      });

      const tasksAt = prompt.indexOf('# Tasks');
      const notesAt = prompt.indexOf('# Durable notes');
      const artifactsAt = prompt.indexOf('# Open artifacts');
      expect(tasksAt).toBeLessThan(notesAt);
      expect(artifactsAt).toBeGreaterThan(notesAt);
    });
  });
});
