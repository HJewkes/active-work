import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import inventoryCmd from '../../src/commands/inventory.js';
import noteListCmd from '../../src/commands/note-list.js';
import sourceListCmd from '../../src/commands/source-list.js';
import {
  charterPath,
  HumanOnlyUnreadableError,
  loadHumanOnlyInitiatives,
} from '../../src/decider/human-only.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const MARKER = 'MARKER-7f3a';

async function writeCharter(root: string, body: string): Promise<void> {
  const file = charterPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
}

async function seedInitiative(root: string): Promise<void> {
  const dir = path.join(root, 'sample-initiative', 'sources');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'pr-1.md'), '# PR\n', 'utf8');
}

async function loadFailure(root: string): Promise<HumanOnlyUnreadableError> {
  const err: unknown = await loadHumanOnlyInitiatives(root).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HumanOnlyUnreadableError);
  return err as HumanOnlyUnreadableError;
}

async function listWarnings(): Promise<string[]> {
  const warnings: string[] = [];
  const run = async (cmd: { run: (args: never, ctx: never) => Promise<unknown> }, args: object) => {
    const context = { activeRoot: '', warnings: [] as string[], format: 'json' as const };
    await cmd.run(args as never, context as never);
    warnings.push(...context.warnings);
  };
  await run(noteListCmd, { all_initiatives: true });
  await run(sourceListCmd, { all_initiatives: true });
  await run(inventoryCmd, {});
  return warnings;
}

describe('human-only charter failure reasons', () => {
  it.each([
    [
      'a YAML syntax error',
      `---\nhuman_only_initiatives: [alpha\nnote: "${MARKER}\n---\nCharter\n`,
      'YAML syntax error at line 3',
    ],
    [
      'a wrong-typed list',
      `---\nhuman_only_initiatives: ${MARKER}\n---\nCharter\n`,
      'wrong type for human_only_initiatives',
    ],
    [
      'a missing key',
      `---\nother: ${MARKER}\n---\nCharter\n`,
      'missing key human_only_initiatives',
    ],
  ])('keeps charter text out of every warning on %s', async (_label, body, reason) => {
    await withEmptyActiveRoot(async (root) => {
      await seedInitiative(root);
      await writeCharter(root, body);

      const err = await loadFailure(root);
      const warnings = await listWarnings();

      expect(err.reason).toBe(reason);
      expect(err.message).not.toContain(MARKER);
      expect(warnings).toHaveLength(3);
      for (const warning of warnings) {
        expect(warning).toContain(reason);
        expect(warning).not.toContain(MARKER);
      }
    });
  });

  it('reports a missing charter as a missing file', async () => {
    await withEmptyActiveRoot(async (root) => {
      const err = await loadFailure(root);

      expect(err.reason).toBe('missing file');
    });
  });

  it('reports an fs error by its errno code only', async () => {
    await withEmptyActiveRoot(async (root) => {
      await fs.mkdir(charterPath(root), { recursive: true });

      const err = await loadFailure(root);

      expect(err.reason).toBe('unreadable (EISDIR)');
    });
  });
});
