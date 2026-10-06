import { promises as fs } from 'node:fs';
import matter from 'gray-matter';
import type { ZodType } from 'zod';
import { classifyStructuredArtifact, recordArtifactHash } from './artifact-hash.js';
import { atomicWrite } from './fs-atomic.js';
import { coerceDates } from './coerce-dates.js';

export interface FrontmatterFile<T> {
  frontmatter: T;
  body: string;
}

const ALLOWED_LANGUAGES: ReadonlySet<string> = new Set(['yaml', 'yml', 'json']);

function refuseLanguage(language: string) {
  const refuse = (): never => {
    throw new Error(
      `Invalid frontmatter: language "${language}" is not allowed (only yaml and json)`,
    );
  };
  return { parse: refuse, stringify: refuse };
}

// gray-matter evals `---js` blocks by default; these overrides keep untrusted files inert.
const SAFE_OPTIONS = {
  language: 'yaml',
  engines: Object.fromEntries(
    ['js', 'javascript', 'coffee', 'coffeescript', 'cson'].map((name) => [
      name,
      refuseLanguage(name),
    ]),
  ),
};

/**
 * Split a markdown string into frontmatter data and body. The only gray-matter
 * parse entry point in the codebase: it throws on any frontmatter language
 * other than yaml or json instead of executing it.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const parsed = matter(raw, SAFE_OPTIONS);
  const language = parsed.language.toLowerCase();
  if (!ALLOWED_LANGUAGES.has(language)) refuseLanguage(language).parse();
  return { data: parsed.data, content: parsed.content };
}

/**
 * Prepend `data` as YAML frontmatter to `body`. The body is passed as a file
 * object so gray-matter writes it verbatim: given a string it re-parses it, and
 * a body that opens with a `---` block would be merged into the frontmatter
 * after validation (TP-1709).
 */
export function stringifyFrontmatter(body: string, data: object): string {
  return matter.stringify(
    { content: body, data: {} } as matter.GrayMatterFile<string>,
    data,
    SAFE_OPTIONS,
  );
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
  const parsed = parseFrontmatter(raw);
  const coerced = coerceDates(parsed.data);
  const result = schema.safeParse(coerced);
  if (!result.success) {
    throw new Error(`Frontmatter validation failed for ${filePath}: ${result.error.message}`);
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
  const parsed = parseFrontmatter(raw);
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
    throw new Error(`Frontmatter validation failed for ${filePath}: ${result.error.message}`);
  }
  const stringified = stringifyFrontmatter(body, result.data as object);
  await atomicWrite(filePath, stringified);
  const artifact = classifyStructuredArtifact(filePath);
  if (artifact) await recordArtifactHash(artifact.initiativeDir, artifact.relPath, stringified);
}
