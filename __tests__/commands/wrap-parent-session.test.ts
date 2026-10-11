import { promises as fs } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import YAML from 'yaml';
import wrap from '../../src/commands/wrap.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { setGitRunner, resetRunners, type CommandRunner } from '../../src/utils/git-gh.js';
import type { CommandContext } from '../../src/registry/index.js';

const NO_GIT: CommandRunner = () => Promise.resolve({ code: 1, stdout: '', stderr: '' });

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return wrap.args.parse({
    slug: 'sample-initiative',
    session_id: 'sess-child',
    started: '2026-05-12T09:00:00Z',
    ended: '2026-05-12T10:30:00Z',
    body: 'what happened\n',
    no_loops: true,
    no_notes: true,
    no_tasks: true,
    ...overrides,
  });
}

async function readFrontmatter(file: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(file, 'utf8');
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  return YAML.parse(block?.[1] ?? '') as Record<string, unknown>;
}

beforeEach(() => {
  setGitRunner(NO_GIT);
});

afterEach(() => {
  resetRunners();
});

describe('wrap --parent-session', () => {
  it('writes parent_session_id to the session file on disk', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await wrap.run(
        baseArgs({ parent_session_id: 'sess-parent' }),
        makeCtx(activeRoot),
      );

      const front = await readFrontmatter(result.path);
      expect(front.parent_session_id).toBe('sess-parent');
    });
  });

  it('writes no parent_session_id key when the flag is absent', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await wrap.run(baseArgs(), makeCtx(activeRoot));

      const front = await readFrontmatter(result.path);
      expect(front).not.toHaveProperty('parent_session_id');
    });
  });
});
