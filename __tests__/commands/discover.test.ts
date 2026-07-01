import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import discoverCmd from '../../src/commands/discover.js';
import foldCmd from '../../src/commands/fold.js';
import dropCmd from '../../src/commands/drop.js';
import trackCmd from '../../src/commands/track.js';
import { withEmptyActiveRoot, withTempActiveRoot } from '../setup/test-helpers.js';
import { NotFoundError, UsageError } from '../../src/errors.js';

const ORIG_CLAUDE_PROJECTS_ROOT = process.env.CLAUDE_PROJECTS_ROOT;

let tempClaudeRoot: string;

beforeEach(() => {
  tempClaudeRoot = mkdtempSync(path.join(tmpdir(), 'aw-claude-cmd-'));
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

const baseCtx = (activeRoot: string) => ({
  activeRoot,
  warnings: [],
  format: 'json' as const,
});

describe('discover command', () => {
  it('returns empty hits and errors when no sources are configured', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const result = await discoverCmd.run({}, baseCtx(activeRoot));
      expect(result).toEqual({ hits: [], errors: [] });
    });
  });
});

describe('fold command', () => {
  it('writes a sidecar session file and appends to .triaged.log', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await foldCmd.run(
        { ref: 'feat/abandoned', into: 'sample-initiative', note: 'merged into main flow' },
        baseCtx(activeRoot),
      );

      expect(result.session_file).toMatch(/sessions\/.*-folded-feat-abandoned\.md$/);
      const fileContents = await fs.readFile(result.session_file, 'utf8');
      expect(fileContents).toContain('feat/abandoned');
      expect(fileContents).toContain('sample-initiative');
      expect(fileContents).toContain('track: sidecar');
      expect(fileContents).toContain('merged into main flow');

      const log = await fs.readFile(path.join(activeRoot, '.triaged.log'), 'utf8');
      expect(log).toMatch(/\tfold\tfeat\/abandoned\tinto:sample-initiative$/m);
    });
  });

  it('rejects unknown initiative slugs', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        foldCmd.run({ ref: 'feat/x', into: 'no-such-initiative' }, baseCtx(activeRoot)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('drop command', () => {
  it('appends a drop line with the reason to .triaged.log', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const result = await dropCmd.run(
        { ref: 'gh:owner/repo#123', reason: 'duplicate' },
        baseCtx(activeRoot),
      );
      expect(result).toEqual({ ref: 'gh:owner/repo#123' });
      const log = await fs.readFile(path.join(activeRoot, '.triaged.log'), 'utf8');
      expect(log).toMatch(/\tdrop\tgh:owner\/repo#123\tduplicate$/m);
    });
  });

  it('records `-` when no reason is supplied', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await dropCmd.run({ ref: 'feat/y' }, baseCtx(activeRoot));
      const log = await fs.readFile(path.join(activeRoot, '.triaged.log'), 'utf8');
      expect(log).toMatch(/\tdrop\tfeat\/y\t-$/m);
    });
  });
});

describe('track command', () => {
  it('scaffolds a new initiative directory and records track in the log', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const result = await trackCmd.run(
        {
          ref: 'feat/new-thing',
          slug: 'new-thing',
          title: 'Build the New Thing',
          ship_target: '2026-Q4',
          owner: 'hjewkes',
          worktree: '~/code/new-thing',
        },
        baseCtx(activeRoot),
      );

      expect(result.slug).toBe('new-thing');
      const dir = path.join(activeRoot, 'new-thing');
      expect(result.dir).toBe(dir);

      const brief = await fs.readFile(path.join(dir, 'brief.md'), 'utf8');
      expect(brief).toContain('title: Build the New Thing');
      expect(brief).toContain('task_prefix: NT');
      expect(brief).toContain('state: backburner');
      expect(brief).toContain('ship_target: 2026-Q4');
      expect(brief).toContain('owner: hjewkes');
      expect(brief).toContain('Source: feat/new-thing');

      const handoff = await fs.readFile(path.join(dir, 'handoff.md'), 'utf8');
      expect(handoff).toContain('feat/new-thing');

      const artifacts = await fs.readFile(path.join(dir, 'artifacts.yml'), 'utf8');
      expect(artifacts).toContain('branches:');
      expect(artifacts).toContain('stashes:');
      expect(artifacts).not.toContain('prs:');

      // subdirs
      const tasksStat = await fs.stat(path.join(dir, 'tasks'));
      const sessionsStat = await fs.stat(path.join(dir, 'sessions'));
      const sourcesStat = await fs.stat(path.join(dir, 'sources'));
      expect(tasksStat.isDirectory()).toBe(true);
      expect(sessionsStat.isDirectory()).toBe(true);
      expect(sourcesStat.isDirectory()).toBe(true);

      const log = await fs.readFile(path.join(activeRoot, '.triaged.log'), 'utf8');
      expect(log).toMatch(/\ttrack\tfeat\/new-thing\tslug:new-thing$/m);
    });
  });

  it('refuses to overwrite an existing initiative', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        trackCmd.run(
          { ref: 'feat/dup', slug: 'sample-initiative' },
          baseCtx(activeRoot),
        ),
      ).rejects.toBeInstanceOf(UsageError);
    });
  });
});
