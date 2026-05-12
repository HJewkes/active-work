import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CURRENT_VERSION, runMigrations } from '../migrations/index.js';

const SCHEMA_VERSION_FILENAME = '.schema-version';

const schemaVersionPath = (activeRoot: string): string =>
  join(activeRoot, SCHEMA_VERSION_FILENAME);

const isNodeErrnoException = (err: unknown): err is NodeJS.ErrnoException =>
  typeof err === 'object' && err !== null && 'code' in err;

export async function readSchemaVersion(activeRoot: string): Promise<number> {
  const path = schemaVersionPath(activeRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      return 0;
    }
    throw err;
  }

  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid schema version in ${path}: expected a positive integer, got ${JSON.stringify(raw)}`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid schema version in ${path}: expected a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

export async function writeSchemaVersion(activeRoot: string, version: number): Promise<void> {
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`Schema version must be a positive integer, got ${version}`);
  }
  await writeFile(schemaVersionPath(activeRoot), `${version}\n`, 'utf8');
}

async function readRawSchemaVersion(
  activeRoot: string,
): Promise<{ present: false } | { present: true; version: number }> {
  const path = schemaVersionPath(activeRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      return { present: false };
    }
    throw err;
  }

  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid schema version in ${path}: expected a non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid schema version in ${path}: expected a non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
  return { present: true, version: parsed };
}

/**
 * Ensures the schema version file is present and up to date.
 *
 * - If the file is missing: writes `CURRENT_VERSION` (fresh install).
 * - If the file equals `CURRENT_VERSION`: no-op.
 * - If the file is older than `CURRENT_VERSION`: runs migrations in
 *   order, then writes the new version.
 * - If the file is newer than `CURRENT_VERSION`: throws (downgrade not
 *   supported).
 *
 * The summary is shaped for CLI/MCP startup logs.
 */
export async function ensureSchemaVersion(activeRoot: string): Promise<{
  before: number;
  after: number;
  migrated: boolean;
  ran: Array<{ from: number; to: number; description: string }>;
}> {
  const raw = await readRawSchemaVersion(activeRoot);

  if (!raw.present) {
    await writeSchemaVersion(activeRoot, CURRENT_VERSION);
    return {
      before: CURRENT_VERSION,
      after: CURRENT_VERSION,
      migrated: false,
      ran: [],
    };
  }

  const before = raw.version;

  if (before === CURRENT_VERSION) {
    return { before, after: before, migrated: false, ran: [] };
  }

  const { ran } = await runMigrations(activeRoot, before);
  await writeSchemaVersion(activeRoot, CURRENT_VERSION);

  return {
    before,
    after: CURRENT_VERSION,
    migrated: ran.length > 0,
    ran: ran.map((m) => ({ from: m.from, to: m.to, description: m.description })),
  };
}
