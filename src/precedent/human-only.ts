import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import type { PrecedentRow } from './schema.js';

/**
 * Initiatives the owner marked human-only hold personal data, so their
 * precedents are never indexed and never returned. The list lives in the
 * autonomy charter's frontmatter, and an unreadable charter fails closed.
 */

const CharterSchema = z.object({ human_only_initiatives: z.array(z.string().min(1)) });

export function charterPath(activeRoot: string): string {
  return path.join(activeRoot, 'claude-channels', 'sources', 'autonomy', 'charter.md');
}

export async function loadHumanOnlyInitiatives(activeRoot: string): Promise<ReadonlySet<string>> {
  const file = charterPath(activeRoot);
  try {
    const parsed = CharterSchema.parse(matter(await fs.readFile(file, 'utf8')).data);
    return new Set(parsed.human_only_initiatives);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot read human_only_initiatives from ${file}; precedents are withheld until it is readable: ${reason}`,
    );
  }
}

/** Keeps only rows whose initiative resolved and is not human-only. */
export function dropHumanOnly(
  rows: PrecedentRow[],
  humanOnly: ReadonlySet<string>,
): PrecedentRow[] {
  return rows.filter((row) => row.initiative !== null && !humanOnly.has(row.initiative));
}
