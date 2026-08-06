import { mkdtempSync, rmSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import resumeCommand from '../../src/commands/resume.js';
import { NotFoundError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

let projectsRoot: string;
const originalEnv = process.env.CLAUDE_PROJECTS_ROOT;

beforeEach(() => {
  // Isolate the `~/.claude/projects` fallback from the operator's real
  // sessions so "unknown session id" tests aren't at the mercy of what
  // happens to exist on the machine running the suite.
  projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'aw-resume-cmd-'));
  process.env.CLAUDE_PROJECTS_ROOT = projectsRoot;
});

afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
  else process.env.CLAUDE_PROJECTS_ROOT = originalEnv;
});

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

async function makeInitiativeWithSession(
  activeRoot: string,
  slug: string,
  sessionId: string,
  worktreePath: string,
): Promise<void> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'artifacts.yml'),
    `branches: []\nstashes: []\nworktrees:\n  - path: ${worktreePath}\n    repo: ${worktreePath}\n    name: main\n    default: true\n`,
  );
  await fs.writeFile(
    path.join(dir, 'sessions', `2026-08-04-1200-${sessionId}.md`),
    [
      '---',
      `session_id: ${sessionId}`,
      'started: 2026-08-04T12:00:00Z',
      'ended: 2026-08-04T13:00:00Z',
      'track: canonical',
      '---',
      '',
      'Session body.',
      '',
    ].join('\n'),
  );
}

describe('resume command', () => {
  it('resolves cwd and source for a known session id', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await makeInitiativeWithSession(
        activeRoot,
        'my-initiative',
        'known-session',
        '/Users/alice/projects/my-initiative',
      );
      const result = await resumeCommand.run({ session_id: 'known-session' }, makeCtx(activeRoot));
      expect(result).toEqual({
        session_id: 'known-session',
        cwd: '/Users/alice/projects/my-initiative',
        source: 'active-work',
        slug: 'my-initiative',
      });
    });
  });

  it('throws NotFoundError for an unknown session id', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await expect(
        resumeCommand.run({ session_id: 'nonexistent' }, makeCtx(activeRoot)),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
