import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readRawFrontmatter } from '../utils/gray-matter-io.js';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

function countBodyLines(body: string): number {
  const lines = body.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.length;
}

/**
 * Read `brief.md` and emit warnings about its prose body.
 *
 * Parses with `readRawFrontmatter` so schema-invalid briefs still get linted
 * — fixing schema issues is the writer's job; lint stays advisory.
 */
export async function lintBrief(
  slug: string,
  initiativeDir: string,
  limits: LintLimits = DEFAULT_LIMITS,
): Promise<LintFinding[]> {
  const filePath = path.join(initiativeDir, 'brief.md');
  try {
    await fs.access(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const { body } = await readRawFrontmatter(filePath);
  const bodyLines = countBodyLines(body);
  if (bodyLines <= limits.briefMaxBodyLines) return [];

  return [
    {
      level: 'warn',
      slug,
      file: 'brief.md',
      message: `body is ${bodyLines} lines (> ${limits.briefMaxBodyLines}). Move resolved/archival content to a purpose-named file under sources/ and trim the brief.`,
    },
  ];
}
