import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import set from '../../src/commands/set.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/types.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

// Hand-written the way a human opts an initiative in: comments, block and flow lists.
const BRIEF_WITH_AUTONOMY = `---
schema_version: 4
title: Burndown demo
updated: '2026-09-01'
state: focused
rank: 1
task_prefix: BD
profile: agents
autonomy:
  mode: burndown  # opted in
  lanes: 2
  accounts:
    - agents
  grants: [merge-on-green-approve, task-close-on-merged-pr]
  repo: ~/projects/agent-chat
---
# Burndown demo
`;

async function scaffold(activeRoot: string, slug: string, text: string): Promise<string> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  const briefPath = path.join(dir, 'brief.md');
  await fs.writeFile(briefPath, text);
  return briefPath;
}

describe('set on a brief that opts into burndown', () => {
  it('rewrites another field and leaves the autonomy block intact', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const briefPath = await scaffold(activeRoot, 'bd', BRIEF_WITH_AUTONOMY);

      await set.run({ slug: 'bd', field: 'owner', value: 'hjewkes' }, makeCtx(activeRoot));

      const written = await fs.readFile(briefPath, 'utf8');
      expect(matter(written).data.owner).toBe('hjewkes');
      expect(matter(written).data.autonomy).toEqual(matter(BRIEF_WITH_AUTONOMY).data.autonomy);
      // agent-chat's line reader needs a block mapping, not a flow `{...}` one.
      expect(written).toMatch(/^autonomy:\n {2}mode: burndown$/m);
    });
  });

  it('refuses a misspelled autonomy key and leaves the file untouched', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const briefPath = await scaffold(activeRoot, 'bd', BRIEF_WITH_AUTONOMY);

      await expect(
        set.run(
          { slug: 'bd', field: 'autonomy.grant', value: ['release-through-ci'] },
          makeCtx(activeRoot),
        ),
      ).rejects.toThrow(/grant/);

      expect(await fs.readFile(briefPath, 'utf8')).toBe(BRIEF_WITH_AUTONOMY);
    });
  });
});
