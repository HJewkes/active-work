import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { atomicWrite, withFileLock } from '../utils/fs-atomic.js';
import { getMinerRoot } from '../utils/paths.js';
import {
  OccurrenceSchema,
  TemplatesFileSchema,
  type Occurrence,
  type Template,
} from '../schemas/template.js';

/**
 * Persistence for the AW-28 Drain miner store: `templates.yml` (bounded,
 * whole-file rewrite on change) and `occurrences.jsonl` (unbounded,
 * append-only). Both live under `getMinerRoot()` — cross-initiative, not
 * scoped to any single slug, since transcripts span every workstream.
 *
 * Drain-tree snapshots (`drain-tree.<toolType>.json`) are an explicitly
 * rebuildable cache per §C1 ("safe to delete and regenerate from
 * `occurrences` + re-running Drain") and are not implemented yet — the
 * canonical source of truth for this first slice is `occurrences.jsonl`
 * plus re-running `ingestBlob`, which is already idempotent.
 */

function templatesPath(root: string): string {
  return path.join(root, 'templates.yml');
}

function occurrencesPath(root: string): string {
  return path.join(root, 'occurrences.jsonl');
}

export async function loadTemplates(root: string = getMinerRoot()): Promise<Template[]> {
  try {
    const file = await readYaml(templatesPath(root), TemplatesFileSchema);
    return file.templates;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function saveTemplates(
  templates: Template[],
  root: string = getMinerRoot(),
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await writeYaml(templatesPath(root), { templates }, TemplatesFileSchema);
}

/**
 * Append one occurrence to `occurrences.jsonl` under an advisory lock, so
 * concurrent writers never interleave partial lines.
 */
export async function appendOccurrence(
  occurrence: Occurrence,
  root: string = getMinerRoot(),
): Promise<void> {
  const parsed = OccurrenceSchema.parse(occurrence);
  const target = occurrencesPath(root);
  await fs.mkdir(root, { recursive: true });
  await withFileLock(`${target}.lock`, async () => {
    await fs.appendFile(target, `${JSON.stringify(parsed)}\n`, 'utf8');
  });
}

/**
 * Append many occurrences under a single lock acquisition and a single
 * `appendFile`. Semantically identical to calling `appendOccurrence` in a
 * loop, but a corpus pass ingests tens of thousands of blobs and paying a
 * lock round-trip per blob dominates the whole run.
 */
export async function appendOccurrences(
  occurrences: Occurrence[],
  root: string = getMinerRoot(),
): Promise<void> {
  if (occurrences.length === 0) return;
  const parsed = occurrences.map((o) => OccurrenceSchema.parse(o));
  const target = occurrencesPath(root);
  await fs.mkdir(root, { recursive: true });
  const body = `${parsed.map((o) => JSON.stringify(o)).join('\n')}\n`;
  await withFileLock(`${target}.lock`, async () => {
    await fs.appendFile(target, body, 'utf8');
  });
}

/** Stream-read every occurrence, validating each line lazily. */
export async function* readOccurrences(root: string = getMinerRoot()): AsyncGenerator<Occurrence> {
  let raw: string;
  try {
    raw = await fs.readFile(occurrencesPath(root), 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    yield OccurrenceSchema.parse(JSON.parse(line));
  }
}

/**
 * Atomically overwrite `occurrences.jsonl` with `occurrences`, in order —
 * used by callers that rebuild the log wholesale (e.g. eviction/compaction),
 * as opposed to `appendOccurrence`'s incremental append.
 */
export async function rewriteOccurrences(
  occurrences: Occurrence[],
  root: string = getMinerRoot(),
): Promise<void> {
  const parsed = occurrences.map((o) => OccurrenceSchema.parse(o));
  await fs.mkdir(root, { recursive: true });
  const body = parsed.map((o) => JSON.stringify(o)).join('\n');
  await atomicWrite(occurrencesPath(root), parsed.length > 0 ? `${body}\n` : '');
}
