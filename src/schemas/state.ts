import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
