import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import migrate from '../../src/commands/migrate.js';
import { PROPOSAL_PATH_ENV } from '../../src/migrations/v3-proposal.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const ctxFor = (activeRoot: string): CommandContext => ({
  activeRoot,
  warnings: [],
  format: 'json',
});

async function scaffold(root: string, slug: string): Promise<void> {
  const dir = path.join(root, slug);
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'brief.md'),
    [
      '---',
      'schema_version: 1',
      `title: ${slug}`,
      "updated: '2026-05-12'",
      'state: backburner',
      'task_prefix: XX',
      '---',
      '',
      `# ${slug}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'tasks', 'XX-3.yml'), 'id: XX-3\n', 'utf8');
  await fs.writeFile(path.join(dir, 'handoff.md'), '# Current state\n\nin flight\n', 'utf8');
}

afterEach(() => {
  delete process.env[PROPOSAL_PATH_ENV];
});

describe('active-work migrate', () => {
  it('--dry-run reports per-initiative changes and writes nothing', async () => {
    await withEmptyActiveRoot(async (root) => {
      await scaffold(root, 'alpha');
      await scaffold(root, 'uncovered-one');
      const proposal = path.join(root, 'proposal.json');
      await fs.writeFile(
        proposal,
        JSON.stringify({
          initiatives: [
            {
              slug: 'alpha',
              ended: '2026-05-12T09:00:00Z',
              session_id: 'handoff-migration',
              body: 'carried over',
              next_steps: [{ id: 'n1', text: 'finish', kind: 'prose' }],
            },
          ],
        }),
        'utf8',
      );
      process.env[PROPOSAL_PATH_ENV] = proposal;

      const result = await migrate.run({ dry_run: true }, ctxFor(root));

      expect(result.applied).toBe(false);
      const alpha = result.initiatives.find((i) => i.slug === 'alpha')!;
      expect(alpha.sessions).toHaveLength(1);
      expect(alpha.sessions[0].kind).toBe('open');
      expect(alpha.sessions[0].action).toBe('write');
      expect(alpha.sessions[0].loops).toBe(1);
      expect(alpha.sessions[0].ended).toBe('2026-05-12T09:00:00Z');
      expect(alpha.task_seq_backfill).toBe(3);
      expect(alpha.handoff).toBe('archive-and-remove');
      expect(result.uncovered).toEqual(['uncovered-one']);

      // Nothing on disk moved.
      await expect(fs.access(path.join(root, 'alpha', 'handoff.md'))).resolves.toBeUndefined();
      expect(await fs.readdir(path.join(root, 'alpha')).then((e) => e.includes('sessions'))).toBe(
        false,
      );
      expect(await fs.readFile(path.join(root, 'alpha', 'brief.md'), 'utf8')).not.toContain(
        'task_seq',
      );
    });
  });

  it('refuses --apply when the root has not reached v2', async () => {
    await withEmptyActiveRoot(async (root) => {
      await fs.writeFile(path.join(root, '.schema-version'), '1\n', 'utf8');
      await expect(migrate.run({ apply: true }, ctxFor(root))).rejects.toThrow(
        /this root is at schema v1/,
      );
    });
  });
});
