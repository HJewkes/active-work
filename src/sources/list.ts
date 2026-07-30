/**
 * Sources are the external material an initiative accumulates: PR write-ups,
 * deep dives, session transcripts, pointers. They live as plain files under
 * `<initiative>/sources/`.
 *
 * There is deliberately no sidecar index and no `sources:` frontmatter field.
 * The listing is derived by reading the directory every time it is asked for,
 * so it cannot drift from what is actually on disk — a hand-maintained list
 * always eventually omits a file someone dropped in by hand (AW-80).
 */

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

/** Naming conventions written by `source add`; see `deriveFilename` there. */
export type SourceType = 'pr' | 'deepdive' | 'session' | 'pointer';

export interface SourceEntry {
  /** Filename including `.md`. */
  filename: string;
  path: string;
  type: SourceType;
  /** First markdown heading, falling back to the filename stem. */
  title: string;
}

/** Resolve the sources directory for an initiative directory. */
export function getSourcesDir(initiativeDir: string): string {
  return path.join(initiativeDir, 'sources');
}

const PR_FILENAME = /^pr-(\d+)-/;
const DEEPDIVE_FILENAME = /^deepdive-/;
const SESSION_FILENAME = /^\d{4}-\d{2}-\d{2}-/;

function inferType(filename: string): SourceType {
  if (PR_FILENAME.test(filename)) return 'pr';
  if (DEEPDIVE_FILENAME.test(filename)) return 'deepdive';
  if (SESSION_FILENAME.test(filename)) return 'session';
  return 'pointer';
}

function firstHeading(contents: string): string | undefined {
  for (const line of contents.split('\n', 200)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

async function readTitle(filePath: string, filename: string): Promise<string> {
  const stem = filename.replace(/\.md$/, '');
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return firstHeading(contents) ?? stem;
  } catch {
    return stem;
  }
}

/**
 * List an initiative's sources by reading `sources/*.md` at call time.
 *
 * Top-level files only: `sources/notes/` is the durable-notes store with its
 * own reader (`loadNotesFromDir`) and its own place in the bootstrap, so
 * folding it in here would double-report it. A missing `sources/` yields an
 * empty list rather than throwing — every caller treats "no sources" and "no
 * directory yet" the same way.
 */
export async function listSources(initiativeDir: string): Promise<SourceEntry[]> {
  const dir = getSourcesDir(initiativeDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const filenames = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const fullPath = path.join(dir, filename);
      return {
        filename,
        path: fullPath,
        type: inferType(filename),
        title: await readTitle(fullPath, filename),
      };
    }),
  );
}

/** Every `sources/...md` path mentioned in a chunk of markdown, deduped. */
export function extractSourceReferences(body: string): string[] {
  const matches = body.matchAll(/sources\/([A-Za-z0-9._/-]+\.md)/g);
  const seen = new Set<string>();
  for (const match of matches) {
    seen.add(match[1]);
  }
  return [...seen].sort();
}
