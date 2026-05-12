import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDiscovery } from '../../src/discover/index.js';
import { withEmptyActiveRoot, withTempActiveRoot } from '../setup/test-helpers.js';
import { discoverProjects } from '../../src/discover/projects.js';
import { discoverGit } from '../../src/discover/git.js';
import { discoverGitHub } from '../../src/discover/github.js';
import { discoverClaudeSessions } from '../../src/discover/claude.js';

const ORIG_CLAUDE_PROJECTS_ROOT = process.env.CLAUDE_PROJECTS_ROOT;

// Point CLAUDE_PROJECTS_ROOT at an empty temp dir for every test so the
// Claude scanner doesn't leak the user's real session data into results.
let tempClaudeRoot: string;

beforeEach(() => {
  tempClaudeRoot = mkdtempSync(path.join(tmpdir(), 'aw-claude-'));
  process.env.CLAUDE_PROJECTS_ROOT = tempClaudeRoot;
});

afterEach(() => {
  rmSync(tempClaudeRoot, { recursive: true, force: true });
  if (ORIG_CLAUDE_PROJECTS_ROOT === undefined) {
    delete process.env.CLAUDE_PROJECTS_ROOT;
  } else {
    process.env.CLAUDE_PROJECTS_ROOT = ORIG_CLAUDE_PROJECTS_ROOT;
  }
});

describe('runDiscovery', () => {
  it('returns empty hits and errors when no sources are configured', async () => {
    await withEmptyActiveRoot(async () => {
      const result = await runDiscovery({});
      expect(result.hits).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  it('cross-references hits against active initiative slugs', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // mini-active-root has `sample-initiative` directory.
      // Build a fake projects root with a subdir whose name contains that slug.
      const projectsRoot = mkdtempSync(path.join(tmpdir(), 'aw-projects-'));
      try {
        mkdirSync(path.join(projectsRoot, 'sample-initiative-work'));
        mkdirSync(path.join(projectsRoot, 'unrelated-project'));

        const result = await runDiscovery({ projects_root: projectsRoot });

        const matched = result.hits.find((h) => h.ref === 'sample-initiative-work');
        const unmatched = result.hits.find((h) => h.ref === 'unrelated-project');

        expect(matched?.slug_match).toBe('sample-initiative');
        expect(matched?.untracked).toBe(false);
        expect(unmatched?.slug_match).toBeUndefined();
        expect(unmatched?.untracked).toBe(true);
        expect(activeRoot).toBeTruthy();
      } finally {
        rmSync(projectsRoot, { recursive: true, force: true });
      }
    });
  });

  it('suppresses hits whose ref appears in the .triaged.log', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const projectsRoot = mkdtempSync(path.join(tmpdir(), 'aw-projects-'));
      try {
        mkdirSync(path.join(projectsRoot, 'kept-project'));
        mkdirSync(path.join(projectsRoot, 'dropped-project'));

        writeFileSync(
          path.join(activeRoot, '.triaged.log'),
          `2026-05-12T00:00:00.000Z\tdrop\tdropped-project\t-\n`,
        );

        const result = await runDiscovery({ projects_root: projectsRoot });

        const refs = result.hits.map((h) => h.ref);
        expect(refs).toContain('kept-project');
        expect(refs).not.toContain('dropped-project');
      } finally {
        rmSync(projectsRoot, { recursive: true, force: true });
      }
    });
  });

  it('matches a slug found in metadata.cwd for Claude session hits', async () => {
    await withTempActiveRoot(async () => {
      // Write a single Claude session JSONL whose cwd contains the slug.
      const projectDir = path.join(tempClaudeRoot, '-Users-someone-code-sample-initiative');
      mkdirSync(projectDir);
      const sessionFile = path.join(projectDir, 'abcdef.jsonl');
      const lines = [
        JSON.stringify({
          type: 'user',
          cwd: '/Users/someone/code/sample-initiative',
          message: { content: 'Hello there, work on this' },
        }),
      ];
      writeFileSync(sessionFile, lines.join('\n') + '\n');

      const result = await runDiscovery({});
      const claudeHit = result.hits.find((h) => h.source === 'claude-session');
      expect(claudeHit).toBeDefined();
      expect(claudeHit?.slug_match).toBe('sample-initiative');
    });
  });
});

describe('discoverProjects', () => {
  it('skips dotfiles and the `active` subdir', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aw-proj-skip-'));
    try {
      mkdirSync(path.join(root, '.cache'));
      mkdirSync(path.join(root, 'active'));
      mkdirSync(path.join(root, 'real-project'));
      const result = await discoverProjects(root);
      expect(result.hits.map((h) => h.ref)).toEqual(['real-project']);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an error when the root is missing', async () => {
    const result = await discoverProjects('/nonexistent/path/that/cannot/be');
    expect(result.hits).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.source).toBe('projects');
  });
});

describe('discoverGit (with injected runCommand)', () => {
  it('aggregates branches, worktrees, and stashes per repo', async () => {
    const fakeRun = vi.fn(async (_bin: string, args: string[]) => {
      // We dispatch on args, not bin, since we always pass `git`.
      if (args.includes('for-each-ref')) {
        return {
          code: 0,
          stdout: 'feat/x|2026-05-10|sketch x\nfeat/y|2026-05-09|sketch y\n',
          stderr: '',
        };
      }
      if (args.includes('worktree')) {
        return {
          code: 0,
          stdout:
            'worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/repo-feat-x\nHEAD def\nbranch refs/heads/feat/x\n',
          stderr: '',
        };
      }
      if (args.includes('stash')) {
        return {
          code: 0,
          stdout: 'stash@{0}: WIP on feat/x: deadbeef sketch\n',
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'unknown args' };
    });

    const result = await discoverGit(['/tmp/repo'], fakeRun);
    expect(result.errors).toEqual([]);
    const refs = result.hits.map((h) => `${h.source}:${h.ref}`);
    expect(refs).toContain('branch:repo:feat/x');
    expect(refs).toContain('branch:repo:feat/y');
    expect(refs).toContain('worktree:repo:feat/x');
    expect(refs).toContain('stash:repo:stash@{0}');
  });

  it('captures non-zero exit codes as per-source errors and continues', async () => {
    const fakeRun = vi.fn(async (_bin: string, args: string[]) => {
      if (args.includes('for-each-ref')) {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      }
      if (args.includes('worktree')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args.includes('stash')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    });

    const result = await discoverGit(['/tmp/repo'], fakeRun);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.source).toBe('branch:repo');
    expect(result.hits).toEqual([]);
  });
});

describe('discoverGitHub (with injected runCommand)', () => {
  it('parses gh JSON output into hits', async () => {
    const fakeRun = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Add thing',
          isDraft: false,
          headRefName: 'feat/add-thing',
          updatedAt: '2026-05-10T12:00:00Z',
        },
      ]),
      stderr: '',
    }));
    const result = await discoverGitHub(['owner/repo'], fakeRun);
    expect(result.errors).toEqual([]);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.source).toBe('gh:owner/repo');
    expect(result.hits[0]?.ref).toBe('feat/add-thing');
    expect(result.hits[0]?.detail).toContain('#42');
  });

  it('records per-repo errors when gh exits non-zero', async () => {
    const fakeRun = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'gh: not authenticated',
    }));
    const result = await discoverGitHub(['owner/repo'], fakeRun);
    expect(result.hits).toEqual([]);
    expect(result.errors).toEqual([
      { source: 'gh:owner/repo', error: 'gh: not authenticated' },
    ]);
  });
});

describe('discoverClaudeSessions', () => {
  it('returns one hit per unique cwd', async () => {
    const a = path.join(tempClaudeRoot, '-Users-me-projA');
    const b = path.join(tempClaudeRoot, '-Users-me-projB');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(
      path.join(a, 's1.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/me/projA', message: { content: 'hi' } }) + '\n',
    );
    writeFileSync(
      path.join(a, 's2.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/me/projA', message: { content: 'hi again' } }) +
        '\n',
    );
    writeFileSync(
      path.join(b, 's1.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/me/projB', message: { content: 'other' } }) +
        '\n',
    );

    const result = await discoverClaudeSessions();
    expect(result.hits).toHaveLength(2);
    const byCwd = new Map(result.hits.map((h) => [h.metadata?.cwd, h]));
    expect(byCwd.get('/Users/me/projA')?.metadata?.sessionCount).toBe(2);
    expect(byCwd.get('/Users/me/projB')?.metadata?.sessionCount).toBe(1);
  });

  it('skips sessions without a cwd', async () => {
    const dir = path.join(tempClaudeRoot, '-tmp-no-cwd');
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 's1.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'no cwd here' } }) + '\n',
    );
    const result = await discoverClaudeSessions();
    expect(result.hits).toEqual([]);
  });

  it('returns an empty result when the projects root is missing', async () => {
    process.env.CLAUDE_PROJECTS_ROOT = path.join(tempClaudeRoot, 'does-not-exist');
    const result = await discoverClaudeSessions();
    expect(result.hits).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

// Silence: keep file readable
void readFileSync;
