import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import type { ZodType } from 'zod';
import { atomicWrite } from './fs-atomic.js';

/**
 * Read and parse a YAML file, validating its contents against `schema`.
 *
 * Throws when the file is unreadable, the YAML is malformed, or the parsed
 * value does not satisfy `schema`. Validation errors include the file path
 * to help locate the offending file.
 */
export async function readYaml<T>(filePath: string, schema: ZodType<T>): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML at ${filePath}: ${reason}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Schema validation failed for ${filePath}: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Write `data` as YAML to `filePath` atomically after validating `schema`.
 *
 * Validation runs before any disk write so an invalid object never lands on
 * disk.
 */
export async function writeYaml<T>(
  filePath: string,
  data: T,
  schema: ZodType<T>,
): Promise<void> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Schema validation failed for ${filePath}: ${result.error.message}`);
  }
  const yaml = YAML.stringify(result.data);
  await atomicWrite(filePath, yaml);
}
