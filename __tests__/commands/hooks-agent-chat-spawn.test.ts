import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handleOnSpawn } from '../../src/commands/hooks-agent-chat-spawn.js';
import { takeSpawnContext } from '../../src/utils/agent-chat-hook-state.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

/** Mirrors `open.test.ts`'s fixture builder — a minimal initiative with a registered worktree. */
async function makeInitiativeWithWorktree(
  activeRoot: string,
  slug: string,
  worktreePath: string,
): Promise<void> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'brief.md'),
    [
      '---',
      'schema_version: 1',
      'title: Demo',
      'updated: 2026-05-12',
      'state: backburner',
      'task_prefix: DEM',
      '---',
      '',
      '# Demo',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(dir, 'artifacts.yml'),
    `branches: []\nstashes: []\nworktrees:\n  - path: ${worktreePath}\n    repo: ${worktreePath}\n    name: main\n    default: true\n`,
  );
}

describe('handleOnSpawn', () => {
  it('resolves the initiative from cwd and stashes the spawn context', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const worktree = path.join(os.homedir(), 'code', 'demo');
      await makeInitiativeWithWorktree(activeRoot, 'demo-init', worktree);

      const result = await handleOnSpawn(
        {
          agentId: 'agent-1',
          name: 'scout',
          session_id: 'sess-abc',
          cwd: worktree,
          parent: null,
          profile: 'explorer',
          briefing: null,
        },
        activeRoot,
      );

      expect(result).toEqual({ matched: true, slug: 'demo-init' });
      // Reading it back also proves it was stashed under the right key.
      const stashed = await takeSpawnContext('agent-1');
      expect(stashed).toMatchObject({ slug: 'demo-init', sessionId: 'sess-abc', name: 'scout' });
    });
  });

  it('is a no-op when cwd does not resolve to any initiative', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await handleOnSpawn(
        {
          agentId: 'agent-2',
          name: 'scout',
          session_id: 'sess-xyz',
          cwd: '/tmp/nowhere-tracked',
          parent: null,
          profile: 'explorer',
          briefing: null,
        },
        activeRoot,
      );

      expect(result).toEqual({ matched: false, slug: null });
      expect(await takeSpawnContext('agent-2')).toBeNull();
    });
  });

  it('is a no-op for a payload missing required fields', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      expect(await handleOnSpawn(null, activeRoot)).toEqual({ matched: false, slug: null });
      expect(await handleOnSpawn({ agentId: 'agent-3' }, activeRoot)).toEqual({
        matched: false,
        slug: null,
      });
    });
  });
});
