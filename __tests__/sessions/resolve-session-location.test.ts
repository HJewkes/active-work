import { mkdtempSync, rmSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveSessionLocation } from '../../src/sessions/resolve-session-location.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

let projectsRoot: string;
const originalEnv = process.env.CLAUDE_PROJECTS_ROOT;

beforeEach(() => {
  projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'aw-resume-'));
  process.env.CLAUDE_PROJECTS_ROOT = projectsRoot;
});

afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
  else process.env.CLAUDE_PROJECTS_ROOT = originalEnv;
});

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

async function writeTranscript(projectDir: string, sessionId: string, cwd: string): Promise<void> {
  const dir = path.join(projectsRoot, projectDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, sessionId })}\n`,
  );
}

describe('resolveSessionLocation', () => {
  it('resolves via active-work session log when a matching session_id exists', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await makeInitiativeWithSession(
        activeRoot,
        'my-initiative',
        'aaaa-bbbb-cccc',
        '/Users/alice/projects/my-initiative',
      );
      const result = await resolveSessionLocation(activeRoot, 'aaaa-bbbb-cccc');
      expect(result).toEqual({
        cwd: '/Users/alice/projects/my-initiative',
        source: 'active-work',
        slug: 'my-initiative',
      });
    });
  });

  it('falls back to ~/.claude/projects when active-work has no record', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await writeTranscript('-Users-alice-scratch', 'dddd-eeee-ffff', '/Users/alice/scratch');
      const result = await resolveSessionLocation(activeRoot, 'dddd-eeee-ffff');
      expect(result).toEqual({ cwd: '/Users/alice/scratch', source: 'claude-projects' });
    });
  });

  it('prefers active-work over ~/.claude/projects when both have the session', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await makeInitiativeWithSession(
        activeRoot,
        'tracked',
        'shared-id',
        '/Users/alice/projects/tracked',
      );
      await writeTranscript('-Users-alice-tracked', 'shared-id', '/Users/alice/projects/tracked');
      const result = await resolveSessionLocation(activeRoot, 'shared-id');
      expect(result?.source).toBe('active-work');
    });
  });

  it('returns null when the session id is unknown everywhere', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const result = await resolveSessionLocation(activeRoot, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  it('does not match a session_id that is merely a filename substring', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      // Filename contains 'abc' but the frontmatter session_id is 'abc-full'.
      await makeInitiativeWithSession(activeRoot, 'my-initiative', 'abc-full', '/tmp/abc-full');
      const result = await resolveSessionLocation(activeRoot, 'abc');
      expect(result).toBeNull();
    });
  });
});
