import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { lintZeroLoops } from '../../src/lint/zero-loops.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

let initiativeDir: string;

interface SessionInput {
  session_id: string;
  track?: 'canonical' | 'sidecar' | 'adhoc';
  next_steps?: unknown[];
  resolves?: unknown[];
  no_loops?: true;
}

async function writeSession(input: SessionInput): Promise<string> {
  const frontmatter: Record<string, unknown> = {
    session_id: input.session_id,
    started: '2026-07-01T00:00:00Z',
    ended: '2026-07-01T00:00:00Z',
    track: input.track ?? 'canonical',
    next_steps: input.next_steps ?? [],
    resolves: input.resolves ?? [],
    ...(input.no_loops ? { no_loops: true } : {}),
  };
  const stem = `2026-07-01-${input.session_id}`;
  await fs.writeFile(
    path.join(initiativeDir, 'sessions', `${stem}.md`),
    `---\n${YAML.stringify(frontmatter)}---\n\nnarrative\n`,
    'utf8',
  );
  return stem;
}

beforeEach(async () => {
  initiativeDir = mkdtempSync(path.join(tmpdir(), 'aw-lint-zero-loops-'));
  await fs.mkdir(path.join(initiativeDir, 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(initiativeDir, { recursive: true, force: true });
});

describe('lintZeroLoops', () => {
  it('returns no findings for an initiative with no sessions', async () => {
    const findings = await lintZeroLoops('slug', initiativeDir);
    expect(findings).toEqual([]);
  });

  it('warns for an unmarked empty ledger', async () => {
    const stem = await writeSession({ session_id: 's1' });
    const findings = await lintZeroLoops('slug', initiativeDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      level: 'warn',
      slug: 'slug',
      file: `sessions/${stem}.md`,
    });
    expect(findings[0].message).toContain('no_loops: true');
  });

  it('is silent when no_loops: true marks the empty ledger', async () => {
    await writeSession({ session_id: 's1', no_loops: true });
    expect(await lintZeroLoops('slug', initiativeDir)).toEqual([]);
  });

  it('is silent when the ledger has next_steps', async () => {
    await writeSession({
      session_id: 's1',
      next_steps: [{ id: 'a', text: 'Do the thing', kind: 'prose' }],
    });
    expect(await lintZeroLoops('slug', initiativeDir)).toEqual([]);
  });

  it('is silent when the ledger has resolves', async () => {
    await writeSession({
      session_id: 's1',
      resolves: [{ ref: 'other#a', outcome: 'done' }],
    });
    expect(await lintZeroLoops('slug', initiativeDir)).toEqual([]);
  });

  it('exempts track: sidecar even without no_loops', async () => {
    await writeSession({ session_id: 's1', track: 'sidecar' });
    expect(await lintZeroLoops('slug', initiativeDir)).toEqual([]);
  });

  it('skips a malformed session file rather than throwing', async () => {
    await fs.writeFile(
      path.join(initiativeDir, 'sessions', 'broken.md'),
      '---\nnot: valid frontmatter for a session\n---\n',
      'utf8',
    );
    expect(await lintZeroLoops('slug', initiativeDir)).toEqual([]);
  });

  it('is silent on the fixture initiative, whose session carries no_loops: true', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const findings = await lintZeroLoops('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });
});
