import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import edit, {
  resolveEditor,
  runEdit,
  type EditorResolver,
  type EditorSpawner,
} from '../../src/commands/edit.js';
import { ValidationError } from '../../src/errors.js';

const VALID_BRIEF = `---
schema_version: 1
title: Sample Initiative
updated: "2026-05-10"
state: focused
rank: 1
ship_target: 2026-Q3
owner: hjewkes
task_prefix: SI
---

# Sample Initiative

Body text.
`;

function fakeResolver(command: string, args: string[]): EditorResolver {
  return async () => ({ command, args });
}

function recordingSpawner(exitCode: number, onCall?: (cmd: string, args: string[]) => void): {
  spawner: EditorSpawner;
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  const spawner: EditorSpawner = async (command, args) => {
    calls.push({ command, args });
    onCall?.(command, args);
    return exitCode;
  };
  return { spawner, calls };
}

describe('edit command', () => {
  it('exports CLI metadata with positional slug + target', () => {
    expect(edit.name).toBe('edit');
    expect(edit.cli?.positional).toEqual(['slug', 'target']);
  });

  it('invokes the resolved editor with the brief.md path', async () => {
    await withTempActiveRoot(async (root) => {
      const briefPath = path.join(root, 'sample-initiative', 'brief.md');
      await fs.writeFile(briefPath, VALID_BRIEF);
      const { spawner, calls } = recordingSpawner(0);

      const result = await runEdit(
        { slug: 'sample-initiative', target: 'brief' },
        { resolveEditor: fakeResolver('vi', [briefPath]), spawner },
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ command: 'vi', args: [briefPath] });
      expect(result.file).toBe(briefPath);
      expect(result.validated).toBe(true);
      expect(result.aborted).toBeUndefined();
    });
  });

  it('returns aborted when the editor exits non-zero (no validation)', async () => {
    await withTempActiveRoot(async (root) => {
      const briefPath = path.join(root, 'sample-initiative', 'brief.md');
      // Corrupt the frontmatter so we know validation is NOT called.
      await fs.writeFile(briefPath, '---\nbroken: true\n---\nbody\n');
      const { spawner } = recordingSpawner(130);

      const result = await runEdit(
        { slug: 'sample-initiative', target: 'brief' },
        { resolveEditor: fakeResolver('vi', [briefPath]), spawner },
      );

      expect(result.aborted).toBe(true);
      expect(result.validated).toBe(false);
    });
  });

  it('throws ValidationError when brief frontmatter is invalid after save', async () => {
    await withTempActiveRoot(async (root) => {
      const briefPath = path.join(root, 'sample-initiative', 'brief.md');
      const spawner: EditorSpawner = async () => {
        await fs.writeFile(
          briefPath,
          '---\nschema_version: 1\ntitle: x\nstate: wat\n---\nbody\n',
        );
        return 0;
      };

      await expect(
        runEdit(
          { slug: 'sample-initiative', target: 'brief' },
          { resolveEditor: fakeResolver('vi', [briefPath]), spawner },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('skips schema validation for handoff target', async () => {
    await withTempActiveRoot(async (root) => {
      const handoffPath = path.join(root, 'sample-initiative', 'handoff.md');
      const { spawner } = recordingSpawner(0);

      const result = await runEdit(
        { slug: 'sample-initiative', target: 'handoff' },
        { resolveEditor: fakeResolver('vi', [handoffPath]), spawner },
      );

      expect(result.validated).toBe(true);
      expect(result.file).toBe(handoffPath);
    });
  });
});

describe('resolveEditor cascading fallback', () => {
  const originalEditor = process.env.EDITOR;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    delete process.env.EDITOR;
  });

  afterEach(() => {
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('prefers $EDITOR via sh -c when set', async () => {
    process.env.EDITOR = 'nvim --noplugin';
    const editor = await resolveEditor('/tmp/x.md');
    expect(editor.command).toBe('sh');
    expect(editor.args).toEqual(['-c', '$EDITOR "$0"', '/tmp/x.md']);
  });

  it('falls back to `code --wait` when $EDITOR is unset and code is on PATH', async () => {
    // Stage a fake `code` binary in an empty PATH dir so `command -v code` finds it.
    const stageDir = await fs.mkdtemp(path.join(process.env.HOME ?? '/tmp', '.aw-stage-'));
    const codePath = path.join(stageDir, 'code');
    await fs.writeFile(codePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = stageDir;

    try {
      const editor = await resolveEditor('/tmp/x.md');
      expect(editor.command).toBe('code');
      expect(editor.args).toEqual(['--wait', '/tmp/x.md']);
    } finally {
      await fs.rm(stageDir, { recursive: true, force: true });
    }
  });

  it('falls back to vi when $EDITOR is unset and code is not found', async () => {
    process.env.PATH = '/nonexistent-dir-aw-test';
    const editor = await resolveEditor('/tmp/x.md');
    expect(editor.command).toBe('vi');
    expect(editor.args).toEqual(['/tmp/x.md']);
  });
});
