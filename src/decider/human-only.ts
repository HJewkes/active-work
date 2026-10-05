import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExclusionPolicy } from '@titan-design/decider';
import { z } from 'zod';
import { parseFrontmatter } from '../utils/gray-matter-io.js';

/**
 * Initiatives the owner marked human-only hold personal data, so their
 * precedents are never indexed and never returned. The list lives in the
 * autonomy charter's frontmatter, and an unreadable charter fails closed.
 * The decider package never reads the charter; active-work passes the list in.
 */

const CharterSchema = z.object({ human_only_initiatives: z.array(z.string().min(1)) });

export function charterPath(activeRoot: string): string {
  return path.join(activeRoot, 'claude-channels', 'sources', 'autonomy', 'charter.md');
}

/** Carries the file and reason so each caller words its own consequence. */
export class HumanOnlyUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(
      `Cannot read human_only_initiatives from ${file}; precedents are withheld until it is readable: ${reason}`,
    );
    this.name = 'HumanOnlyUnreadableError';
  }
}

export async function loadHumanOnlyInitiatives(activeRoot: string): Promise<ReadonlySet<string>> {
  const file = charterPath(activeRoot);
  let data: Record<string, unknown>;
  try {
    data = parseFrontmatter(await fs.readFile(file, 'utf8')).data;
  } catch (err) {
    throw new HumanOnlyUnreadableError(file, readFailureReason(err));
  }
  const parsed = CharterSchema.safeParse(data);
  if (!parsed.success) throw new HumanOnlyUnreadableError(file, schemaFailureReason(data));
  return new Set(parsed.data.human_only_initiatives);
}

// Reasons are a fixed vocabulary: js-yaml and zod messages can quote charter text, and
// these reasons reach list, inventory and decider warnings.
function readFailureReason(err: unknown): string {
  if (!(err instanceof Error)) return 'unreadable';
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'missing file';
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return `unreadable (${code})`;
  if (err.name === 'YAMLException') return yamlSyntaxReason(err);
  return 'unreadable';
}

function yamlSyntaxReason(err: Error): string {
  const line = (err as { mark?: { line?: unknown } }).mark?.line;
  return typeof line === 'number' ? `YAML syntax error at line ${line + 1}` : 'YAML syntax error';
}

function schemaFailureReason(data: unknown): string {
  const hasKey = typeof data === 'object' && data !== null && 'human_only_initiatives' in data;
  return hasKey ? 'wrong type for human_only_initiatives' : 'missing key human_only_initiatives';
}

export function exclusionPolicy(humanOnly: ReadonlySet<string>): ExclusionPolicy {
  return { humanOnlyInitiatives: [...humanOnly], projectInitiatives: [], personalDataPatterns: [] };
}
