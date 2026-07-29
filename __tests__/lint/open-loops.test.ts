import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { lintOpenLoops } from '../../src/lint/open-loops.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const NOW = new Date('2026-07-28T00:00:00Z');
const LIMITS = {
  handoffMaxBodyLines: 100,
  briefMaxBodyLines: 150,
  taskNotesMaxLines: 30,
  openLoopMaxAgeDays: 30,
};

let initiativeDir: string;

interface SessionInput {
  session_id: string;
  ended: string;
  next_steps?: unknown[];
  resolves?: unknown[];
}

async function writeSession(input: SessionInput): Promise<string> {
  const frontmatter = {
    session_id: input.session_id,
    started: input.ended,
    ended: input.ended,
    track: 'canonical',
    next_steps: input.next_steps ?? [],
    resolves: input.resolves ?? [],
  };
  const stem = `${input.ended.slice(0, 10)}-${input.session_id}`;
  await fs.writeFile(
    path.join(initiativeDir, 'sessions', `${stem}.md`),
    `---\n${YAML.stringify(frontmatter)}---\n\nnarrative\n`,
    'utf8',
  );
  return stem;
}

beforeEach(async () => {
  initiativeDir = mkdtempSync(path.join(tmpdir(), 'aw-lint-loops-'));
  await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(initiativeDir, { recursive: true, force: true });
});

describe('lintOpenLoops', () => {
  it('returns no findings for an initiative with no sessions', async () => {
    const findings = await lintOpenLoops('slug', initiativeDir, LIMITS, NOW);
    expect(findings).toEqual([]);
  });

  it('does not warn for an aged loop whose task is already done', async () => {
    await writeSession({
      session_id: 's-done',
      ended: '2026-06-01T00:00:00Z', // 57 days before NOW
      next_steps: [{ id: 'a', text: 'Ship the rollup', kind: 'task', ref: 'AW-24' }],
    });
    await fs.mkdir(path.join(initiativeDir, 'tasks'), { recursive: true });
    await fs.writeFile(
      path.join(initiativeDir, 'tasks', 'AW-24.yml'),
      YAML.stringify({
        id: 'AW-24',
        title: 'Ship the rollup',
        priority: 1,
        status: 'done',
        created: '2026-06-01',
        updated: '2026-06-02',
        done_at: '2026-06-02',
      }),
      'utf8',
    );

    // The rule must load tasks itself; without them the loop never
    // auto-resolves and this aged, finished work warns forever.
    expect(await lintOpenLoops('slug', initiativeDir, LIMITS, NOW)).toEqual([]);
  });

  it('warns for a loop older than the cap', async () => {
    const stem = await writeSession({
      session_id: 's1',
      ended: '2026-06-01T00:00:00Z', // 57 days before NOW
      next_steps: [{ id: 'a', text: 'Finish the thing', kind: 'prose' }],
    });

    const findings = await lintOpenLoops('slug', initiativeDir, LIMITS, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      level: 'warn',
      slug: 'slug',
      file: `sessions/${stem}.md`,
    });
    expect(findings[0].message).toContain(`${stem}#a`);
    expect(findings[0].message).toContain('57 days old');
    expect(findings[0].message).toContain('abandoned');
  });

  // AW-74: a pr loop cannot close itself, because derivation stays offline and
  // never learns the PR merged. Telling the operator to abandon it is exactly
  // wrong for work that shipped, so the aged-loop advice has to differ by kind.
  it('tells a stale pr loop to resolve as done, not abandoned', async () => {
    await writeSession({
      session_id: 's1',
      ended: '2026-06-01T00:00:00Z',
      next_steps: [{ id: 'a', text: 'Merge the branch', kind: 'pr', ref: '57' }],
    });

    const findings = await lintOpenLoops('slug', initiativeDir, LIMITS, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('can never close itself');
    expect(findings[0].message).toContain('outcome: done');
    expect(findings[0].message).not.toMatch(/with outcome: abandoned/);
  });

  it('keeps the abandon advice for a non-pr stale loop', async () => {
    await writeSession({
      session_id: 's1',
      ended: '2026-06-01T00:00:00Z',
      next_steps: [{ id: 'a', text: 'Decide the thing', kind: 'prose' }],
    });

    const findings = await lintOpenLoops('slug', initiativeDir, LIMITS, NOW);
    expect(findings[0].message).toContain('with outcome: abandoned');
    expect(findings[0].message).not.toContain('can never close itself');
  });

  it('does not warn exactly at the threshold', async () => {
    await writeSession({
      session_id: 's1',
      ended: '2026-06-28T00:00:00Z', // exactly 30 days before NOW
      next_steps: [{ id: 'a', text: 'On the edge', kind: 'prose' }],
    });

    const findings = await lintOpenLoops('slug', initiativeDir, LIMITS, NOW);
    expect(findings).toEqual([]);
  });

  it('does not warn for a loop under the cap', async () => {
    await writeSession({
      session_id: 's1',
      ended: '2026-07-20T00:00:00Z',
      next_steps: [{ id: 'a', text: 'Recent', kind: 'prose' }],
    });

    const findings = await lintOpenLoops('slug', initiativeDir, LIMITS, NOW);
    expect(findings).toEqual([]);
  });

  it('does not warn for a resolved loop, even if old', async () => {
    const stem = await writeSession({
      session_id: 's1',
      ended: '2026-06-01T00:00:00Z',
      next_steps: [{ id: 'a', text: 'Old but resolved', kind: 'prose' }],
    });
    await writeSession({
      session_id: 's2',
      ended: '2026-06-05T00:00:00Z',
      resolves: [{ ref: `${stem}#a`, outcome: 'done' }],
    });

    const findings = await lintOpenLoops('slug', initiativeDir, LIMITS, NOW);
    expect(findings).toEqual([]);
  });

  it('skips a malformed session file rather than throwing', async () => {
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', 'broken.md'),
      '---\nnot: valid frontmatter for a session\n---\n',
      'utf8',
    );

    const findings = await lintOpenLoops('slug', initiativeDir, LIMITS, NOW);
    expect(findings).toEqual([]);
  });

  it('returns [] against the clean fixture initiative', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const findings = await lintOpenLoops('sample-initiative', dir, LIMITS, NOW);
      expect(findings).toEqual([]);
    });
  });
});
