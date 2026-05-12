import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/errors.js';
import { CURRENT_VERSION } from '../../src/migrations/index.js';
import {
  ensureSchemaVersion,
  readSchemaVersion,
} from '../../src/schemas/state.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const schemaVersionFile = (root: string): string => join(root, '.schema-version');

describe('ensureSchemaVersion', () => {
  it('writes CURRENT_VERSION when .schema-version is missing (fresh install)', async () => {
    await withEmptyActiveRoot(async (root) => {
      const result = await ensureSchemaVersion(root);

      expect(result).toEqual({
        before: CURRENT_VERSION,
        after: CURRENT_VERSION,
        migrated: false,
        ran: [],
      });

      const onDisk = await readSchemaVersion(root);
      expect(onDisk).toBe(CURRENT_VERSION);
    });
  });

  it('is a no-op on an already-current activeRoot', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeFile(schemaVersionFile(root), `${CURRENT_VERSION}\n`, 'utf8');

      const result = await ensureSchemaVersion(root);

      expect(result).toEqual({
        before: CURRENT_VERSION,
        after: CURRENT_VERSION,
        migrated: false,
        ran: [],
      });

      // File contents unchanged.
      const raw = await readFile(schemaVersionFile(root), 'utf8');
      expect(raw.trim()).toBe(String(CURRENT_VERSION));
    });
  });

  it('throws ConfigError when .schema-version is older with no migrator registered', async () => {
    await withEmptyActiveRoot(async (root) => {
      // Manually stamp a "v0" file — no v0 -> v1 migrator ships by design.
      await writeFile(schemaVersionFile(root), '0\n', 'utf8');

      await expect(ensureSchemaVersion(root)).rejects.toBeInstanceOf(ConfigError);
      await expect(ensureSchemaVersion(root)).rejects.toThrow(/Gap at v0 -> v1/);
    });
  });

  it('throws ConfigError when .schema-version is newer than CURRENT_VERSION', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeFile(
        schemaVersionFile(root),
        `${CURRENT_VERSION + 1}\n`,
        'utf8',
      );

      await expect(ensureSchemaVersion(root)).rejects.toBeInstanceOf(ConfigError);
      await expect(ensureSchemaVersion(root)).rejects.toThrow(/downgrade not supported/i);
    });
  });

  it('returns the contract shape', async () => {
    await withEmptyActiveRoot(async (root) => {
      const result = await ensureSchemaVersion(root);
      expect(result).toHaveProperty('before');
      expect(result).toHaveProperty('after');
      expect(result).toHaveProperty('migrated');
      expect(result).toHaveProperty('ran');
      expect(Array.isArray(result.ran)).toBe(true);
    });
  });
});
