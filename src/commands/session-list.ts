import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import matter from 'gray-matter';
import { SessionFrontmatterSchema } from '../schemas/session.js';
import type { SessionFrontmatter } from '../schemas/session.js';
import { getInitiativeDir } from '../utils/paths.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  limit: z.number().int().positive().optional(),
});

const SessionEntrySchema = z.object({
  filename: z.string(),
  frontmatter: SessionFrontmatterSchema,
  first_line: z.string(),
});

const ResultSchema = z.object({
  sessions: z.array(SessionEntrySchema),
  errors: z.array(z.object({ filename: z.string(), error: z.string() })),
});

const DEFAULT_LIMIT = 100;
const MAX_FIRST_LINE = 120;

function extractFirstLine(body: string): string {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return trimmed.length > MAX_FIRST_LINE
      ? trimmed.slice(0, MAX_FIRST_LINE)
      : trimmed;
  }
  return '';
}

interface ListEntry {
  filename: string;
  frontmatter: SessionFrontmatter;
  first_line: string;
}

interface ListError {
  filename: string;
  error: string;
}

async function listSessionFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * YAML parses unquoted ISO 8601 timestamps as `Date` instances. The session
 * schema expects ISO strings, so coerce known timestamp fields back to their
 * string form before validation.
 */
function coerceTimestamps(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const field of ['started', 'ended'] as const) {
    const value = out[field];
    if (value instanceof Date) {
      out[field] = value.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  }
  return out;
}

async function readSession(
  filePath: string,
): Promise<{ frontmatter: SessionFrontmatter; body: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const coerced = coerceTimestamps(parsed.data as Record<string, unknown>);
  const result = SessionFrontmatterSchema.safeParse(coerced);
  if (!result.success) {
    throw new Error(
      `Frontmatter validation failed for ${filePath}: ${result.error.message}`,
    );
  }
  return { frontmatter: result.data, body: parsed.content };
}

export default defineCommand({
  name: 'session.list',
  description: 'List session summaries for an initiative, sorted by end time',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      limit: {
        long: '--limit',
        description: `Maximum sessions to return (default ${DEFAULT_LIMIT})`,
      },
    },
    usage: 'session.list <slug> [--limit N]',
  },
  async run(args) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const sessionsDir = path.join(getInitiativeDir(args.slug), 'sessions');
    const filenames = await listSessionFiles(sessionsDir);

    const entries: ListEntry[] = [];
    const errors: ListError[] = [];

    for (const filename of filenames) {
      const fullPath = path.join(sessionsDir, filename);
      try {
        const { frontmatter, body } = await readSession(fullPath);
        entries.push({
          filename,
          frontmatter,
          first_line: extractFirstLine(body),
        });
      } catch (err) {
        errors.push({
          filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    entries.sort((a, b) => {
      const aEnded = new Date(a.frontmatter.ended).getTime();
      const bEnded = new Date(b.frontmatter.ended).getTime();
      return bEnded - aEnded;
    });

    return { sessions: entries.slice(0, limit), errors };
  },
});
