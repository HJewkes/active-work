import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hashContent, readArtifactHashes } from '../utils/artifact-hash.js';
import type { LintFinding } from './types.js';

/**
 * Compare each tracked structured artifact's on-disk content against the
 * hash recorded at its last CLI write. Files with no manifest entry (never
 * CLI-written, or predating AW-66) are silently skipped rather than flagged
 * — an empty manifest must never read as "everything drifted".
 *
 * A manifest entry whose file has since been deleted (e.g. `task delete`,
 * which does not route through `writeYaml`) is also skipped: absence is not
 * drift.
 */
export async function lintHashes(slug: string, initiativeDir: string): Promise<LintFinding[]> {
  const manifest = await readArtifactHashes(initiativeDir);
  const findings: LintFinding[] = [];

  for (const [relPath, storedHash] of Object.entries(manifest)) {
    let content: string;
    try {
      content = await fs.readFile(path.join(initiativeDir, relPath), 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw err;
    }
    if (hashContent(content) === storedHash) continue;
    findings.push({
      level: 'warn',
      slug,
      file: relPath,
      message: `${relPath} was hand-edited outside active-work (content no longer matches the last CLI write) — re-apply the change through the CLI/MCP tools instead of editing the file directly`,
    });
  }

  return findings;
}
