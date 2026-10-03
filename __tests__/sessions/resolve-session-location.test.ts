import { mkdtempSync, rmSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveSessionLocation } from '../../src/sessions/resolve-session-location.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

let projectsRoot: string;
const originalEnv = process.env.CLAUDE_PROJECTS_ROOT;

beforeEach(() => {
  projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'aw-resume-'));
  process.env.CLAUDE_PROJECTS_ROOT = projectsRoot;
});

afterEach(() => {
  vi.unstubAllEnvs();
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
        cwd: path.join(activeRoot, 'my-initiative'),
        source: 'active-work',
        slug: 'my-initiative',
      });
    });
  });

  it('resumes into the initiative directory even when a default worktree is registered', async () => {
    // AW-115: registering a worktree states where dispatched agents run; it
    // must not relocate the operator's own session. Registering one used to
    // move both, so a session that ran in the initiative dir resumed in a
    // repo it had never been opened in.
    await withEmptyActiveRoot(async (activeRoot) => {
      await makeInitiativeWithSession(
        activeRoot,
        'example-app',
        'ran-in-notes-dir',
        '/Users/alice/code',
      );
      const result = await resolveSessionLocation(activeRoot, 'ran-in-notes-dir');
      expect(result?.cwd).toBe(path.join(activeRoot, 'example-app'));
      expect(result?.cwd).not.toBe('/Users/alice/code');
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

  it('resolves a session that lives under a profile root', async () => {
    const configDirs = ['.claude', 'agents'].map((name) => path.join(projectsRoot, name));
    const profileProject = path.join(configDirs[1]!, 'projects', '-Users-alice-agent');
    await fs.mkdir(path.join(configDirs[0]!, 'projects'), { recursive: true });
    await fs.mkdir(profileProject, { recursive: true });
    await fs.writeFile(
      path.join(profileProject, 'prof-ile-id.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/Users/alice/agent', sessionId: 'prof-ile-id' })}\n`,
    );
    vi.stubEnv('CLAUDE_PROJECTS_ROOT', '');
    vi.stubEnv('CLAUDE_CONFIG_DIRS', configDirs.join(path.delimiter));

    await withEmptyActiveRoot(async (activeRoot) => {
      const result = await resolveSessionLocation(activeRoot, 'prof-ile-id');
      expect(result).toEqual({
        cwd: '/Users/alice/agent',
        source: 'claude-projects',
        configDir: configDirs[1],
      });
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

describe('resolveSessionLocation config dirs', () => {
  async function writeIn(configDir: string, sessionId: string, cwd: string): Promise<void> {
    const dir = path.join(configDir, 'projects', '-synthetic');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ cwd })}\n`);
  }

  function useConfigDirs(...dirs: string[]): void {
    vi.stubEnv('CLAUDE_PROJECTS_ROOT', '');
    vi.stubEnv('CLAUDE_CONFIG_DIRS', dirs.join(path.delimiter));
  }

  it('reports the profile config dir a session was found under', async () => {
    const profileDir = path.join(projectsRoot, 'agents');
    await writeIn(profileDir, 'in-profile', '/synthetic/a');
    useConfigDirs(path.join(projectsRoot, '.claude'), profileDir);
    await withEmptyActiveRoot(async (activeRoot) => {
      const result = await resolveSessionLocation(activeRoot, 'in-profile');
      expect(result?.configDir).toBe(profileDir);
    });
  });

  it('omits configDir for the default config dir', async () => {
    const defaultDir = path.join(projectsRoot, '.claude');
    await writeIn(defaultDir, 'in-default', '/synthetic/b');
    useConfigDirs(defaultDir, path.join(projectsRoot, 'agents'));
    await withEmptyActiveRoot(async (activeRoot) => {
      const result = await resolveSessionLocation(activeRoot, 'in-default');
      expect(result).toEqual({ cwd: '/synthetic/b', source: 'claude-projects' });
    });
  });

  it('refuses to guess when two config dirs hold the same session', async () => {
    const dirs = ['.claude', 'agents'].map((n) => path.join(projectsRoot, n));
    for (const dir of dirs) await writeIn(dir, 'dup-id', '/synthetic/c');
    useConfigDirs(...dirs);
    await withEmptyActiveRoot(async (activeRoot) => {
      await expect(resolveSessionLocation(activeRoot, 'dup-id')).rejects.toThrow(
        /~\/\.claude and .*agents/,
      );
    });
  });

  it('prefers the config dir of the profile the session log initiative declares', async () => {
    const dirs = ['.claude', 'agents'].map((n) => path.join(projectsRoot, n));
    for (const dir of dirs) await writeIn(dir, 'dup-logged', '/synthetic/d');
    useConfigDirs(...dirs);
    vi.stubEnv('CLAUDE_PROFILE_ROOT', projectsRoot);
    await withEmptyActiveRoot(async (activeRoot) => {
      await makeInitiativeWithSession(activeRoot, 'logged', 'dup-logged', '/synthetic/d');
      await fs.writeFile(
        path.join(activeRoot, 'logged', 'brief.md'),
        '---\nprofile: agents\n---\n',
      );
      const result = await resolveSessionLocation(activeRoot, 'dup-logged');
      expect(result?.configDir).toBe(dirs[1]);
    });
  });
});
