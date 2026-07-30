import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleBootstrap } from '../../src/bootstrap/prompt.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SAMPLE_SLUG = 'sample-initiative';
const FIXTURE_NOW = new Date('2026-05-12T16:00:00Z');

const offlineOpts = { includeLiveStatus: false } as const;

function initiativePath(activeRoot: string, ...parts: string[]): string {
  return path.join(activeRoot, SAMPLE_SLUG, ...parts);
}

async function bootstrap(activeRoot: string): Promise<string> {
  const { prompt } = await assembleBootstrap({
    activeRoot,
    slug: SAMPLE_SLUG,
    now: FIXTURE_NOW,
    ...offlineOpts,
  });
  return prompt;
}

/** Replace the brief body while keeping the fixture's valid frontmatter. */
async function rewriteBriefBody(activeRoot: string, body: string): Promise<void> {
  const briefPath = initiativePath(activeRoot, 'brief.md');
  const raw = await fs.readFile(briefPath, 'utf8');
  const frontmatter = raw.slice(0, raw.indexOf('\n---\n') + '\n---\n'.length);
  await fs.writeFile(briefPath, `${frontmatter}\n${body}`);
}

describe('malformed task files', () => {
  it('reports the unreadable file instead of silently shrinking the list', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await fs.writeFile(
        initiativePath(activeRoot, 'tasks', 'SI-9.yml'),
        'id: SI-9\ntitle: [unclosed\n',
      );
      const prompt = await bootstrap(activeRoot);
      expect(prompt).toContain('1 task file(s) unreadable');
      expect(prompt).toContain('SI-9.yml');
    });
  });

  it('still renders the tasks that did parse', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await fs.writeFile(
        initiativePath(activeRoot, 'tasks', 'SI-9.yml'),
        'id: SI-9\npriority: not-a-number\n',
      );
      const prompt = await bootstrap(activeRoot);
      expect(prompt).toContain('[SI-1]');
      expect(prompt).toContain('task file(s) unreadable');
    });
  });

  it('says nothing about unreadable files when every task parses', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const prompt = await bootstrap(activeRoot);
      expect(prompt).not.toContain('task file(s) unreadable');
    });
  });
});

describe('artifacts.yml read failures', () => {
  it('surfaces a corrupted artifacts.yml rather than rendering an empty ledger', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await fs.writeFile(
        initiativePath(activeRoot, 'artifacts.yml'),
        'branches:\n  - repo: [unclosed\n',
      );
      const prompt = await bootstrap(activeRoot);
      expect(prompt).toContain('# Open artifacts');
      expect(prompt).toContain('could not be read');
      expect(prompt).toContain('artifacts.yml');
      expect(prompt).not.toContain('feat/sample');
    });
  });

  it('surfaces a schema-invalid artifacts.yml too', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await fs.writeFile(initiativePath(activeRoot, 'artifacts.yml'), 'branches: "not a list"\n');
      const prompt = await bootstrap(activeRoot);
      expect(prompt).toContain('could not be read');
    });
  });

  it('treats a missing artifacts.yml as a legitimate empty state', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await fs.rm(initiativePath(activeRoot, 'artifacts.yml'));
      const prompt = await bootstrap(activeRoot);
      expect(prompt).not.toContain('could not be read');
      expect(prompt).not.toContain('# Open artifacts');
    });
  });
});

describe('truncation markers', () => {
  it('marks a truncated brief with the count and the brief path', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const body = Array.from({ length: 50 }, (_, i) => `brief line ${i + 1}`).join('\n');
      await rewriteBriefBody(activeRoot, body);
      const prompt = await bootstrap(activeRoot);
      expect(prompt).toContain('brief line 40');
      expect(prompt).not.toContain('brief line 41');
      expect(prompt).toContain(`…(+10 lines — see ${initiativePath(activeRoot, 'brief.md')})`);
    });
  });

  it('leaves a short brief unmarked', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await rewriteBriefBody(activeRoot, 'one line only\n');
      const prompt = await bootstrap(activeRoot);
      expect(prompt).not.toContain('lines — see');
    });
  });

  it('marks a truncated session excerpt with the session file path', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const stem = '2026-05-11-0900-truncme';
      const front = [
        '---',
        'session_id: truncme',
        'started: 2026-05-11T09:00:00Z',
        'ended: 2026-05-11T11:00:00Z',
        'track: canonical',
        'no_loops: true',
        '---',
        '',
      ].join('\n');
      const body = Array.from({ length: 30 }, (_, i) => `session line ${i + 1}`).join('\n');
      await fs.writeFile(initiativePath(activeRoot, 'sessions', `${stem}.md`), front + body);
      const prompt = await bootstrap(activeRoot);
      expect(prompt).toContain('session line 25');
      expect(prompt).not.toContain('session line 26');
      expect(prompt).toContain(
        `…(+5 lines — see ${initiativePath(activeRoot, 'sessions', `${stem}.md`)})`,
      );
    });
  });
});
