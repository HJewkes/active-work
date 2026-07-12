import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import promptCommand from '../../src/commands/prompt.js';
import { NotFoundError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

function makeCtx(activeRoot: string, cwd?: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', cwd };
}

describe('prompt command', () => {
  it('resolves by slug and returns the raw bootstrap prompt text', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await promptCommand.run(
        { slug: 'sample-initiative', offline: true },
        makeCtx(activeRoot),
      );
      expect(typeof out).toBe('string');
      expect(out).toContain('Sample Initiative');
    });
  });

  it('resolves a unique prefix', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await promptCommand.run(
        { slug: 'sample', offline: true },
        makeCtx(activeRoot),
      );
      expect(out).toContain('Sample Initiative');
    });
  });

  it('resolves from the cwd arg when no slug is given', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await promptCommand.run(
        { cwd: path.join(os.homedir(), 'code/sample/src'), offline: true },
        makeCtx(activeRoot),
      );
      expect(out).toContain('Sample Initiative');
    });
  });

  it('resolves from the context cwd when no cwd arg is given', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const out = await promptCommand.run(
        { offline: true },
        makeCtx(activeRoot, path.join(os.homedir(), 'code/sample')),
      );
      expect(out).toContain('Sample Initiative');
    });
  });

  it('throws NotFoundError when no slug and the cwd matches nothing', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        promptCommand.run(
          { cwd: path.join(os.homedir(), 'code/unrelated'), offline: true },
          makeCtx(activeRoot),
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  it('does not archive stale done tasks (side-effect-free)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // Seed a done task old enough that `open` would archive it.
      const taskPath = path.join(
        activeRoot,
        'sample-initiative',
        'tasks',
        'SI-9.yml',
      );
      await fs.writeFile(
        taskPath,
        [
          'id: SI-9',
          'title: Ancient done task',
          'priority: 9',
          'status: done',
          'created: 2020-01-01',
          'updated: 2020-01-02',
          'done_at: 2020-01-02',
          '',
        ].join('\n'),
      );

      await promptCommand.run(
        { slug: 'sample-initiative', offline: true },
        makeCtx(activeRoot),
      );

      // The task file stays put — `prompt` never archives.
      await expect(fs.stat(taskPath)).resolves.toBeDefined();
      const archiveDir = path.join(
        activeRoot,
        'sample-initiative',
        'tasks',
        'archive',
      );
      await expect(fs.stat(archiveDir)).rejects.toThrow();
    });
  });
});
