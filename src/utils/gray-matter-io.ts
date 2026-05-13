import { promises as fs } from 'node:fs';
import matter from 'gray-matter';
import type { ZodType } from 'zod';
import { atomicWrite } from './fs-atomic.js';
import { coerceDates } from './coerce-dates.js';

export interface FrontmatterFile<T> {
  frontmatter: T;
  body: string;
}

/**
 * Read a markdown file with YAML frontmatter and validate the frontmatter
 * against `schema`.
 *
 * Throws when the file is unreadable or the frontmatter does not satisfy the
 * schema. Errors include the file path so the caller can act on them.
 */
export async function readFrontmatter<T>(
  filePath: string,
  schema: ZodType<T>,
): Promise<FrontmatterFile<T>> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const coerced = coerceDates(parsed.data);
  const result = schema.safeParse(coerced);
  if (!result.success) {
    throw new Error(
      `Frontmatter validation failed for ${filePath}: ${result.error.message}`,
    );
  }
  return { frontmatter: result.data, body: parsed.content };
}

/**
 * Read a markdown file's frontmatter without schema validation.
 *
 * Used by repair-style flows (e.g. `active-work set`) that need to fix files whose
 * frontmatter is currently invalid.
 */
export async function readRawFrontmatter(
  filePath: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const coerced = coerceDates(parsed.data) as Record<string, unknown>;
  return {
    frontmatter: { ...coerced },
    body: parsed.content,
  };
}

/**
 * Validate `frontmatter` against `schema`, then atomically write the
 * combined frontmatter + body to `filePath`.
 */
export async function writeFrontmatter<T>(
  filePath: string,
  frontmatter: T,
  body: string,
  schema: ZodType<T>,
): Promise<void> {
  const result = schema.safeParse(frontmatter);
  if (!result.success) {
    throw new Error(
      `Frontmatter validation failed for ${filePath}: ${result.error.message}`,
    );
  }
  const stringified = matter.stringify(body, result.data as object);
  await atomicWrite(filePath, stringified);
}
