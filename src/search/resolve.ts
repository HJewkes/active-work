import path from 'node:path';
import { readLocatorText } from '@titan-design/locator';
import type { WorkspaceGraph } from '../session-index/graph.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from '../workspace-index/schema.js';
import { toAbsolute } from '../workspace-index/refs.js';
import { classOf } from './classes.js';

/**
 * Turning a fused id back into something an operator can act on.
 *
 * A result is only useful if it names a file the reader can open. Nothing here
 * stores text twice: the excerpt is read from the real file through the span's
 * locator, which is the whole point of a contentless index.
 */

export interface ResolvedHit {
  ref: string;
  class: string;
  initiative: string | null;
  title: string | null;
  /** Path relative to the active root for workspace rows; absolute for transcripts. */
  path: string | null;
  excerpt: string | null;
  score: number;
  /** Which retrievers found it, so a result can be explained. */
  sources: string[];
}

/** Where a class's rows live, and what stands in for a title. */
const ROW_SOURCES: { table: string; refColumn: string; title: string }[] = [
  { table: 'note', refColumn: 'note_ref', title: 'title' },
  { table: 'workspace_task', refColumn: 'task_ref', title: 'title' },
  { table: 'source', refColumn: 'source_ref', title: 'title' },
  { table: 'initiative', refColumn: 'initiative_ref', title: 'title' },
  { table: 'session_record', refColumn: 'session_ref', title: 'session_id' },
];

interface RowFacts {
  initiative: string | null;
  title: string | null;
  path: string | null;
}

/**
 * The row behind a ref, from whichever class table owns it.
 *
 * Rows are keyed by path and the ref is merely indexed, so one ref can name
 * several files — `handoff-migration` is one session id across 17 initiatives.
 * The first is taken, because a search result points at a representative file
 * rather than claiming to be the only one.
 */
function rowFor(graph: WorkspaceGraph, ref: string): RowFacts | null {
  for (const { table, refColumn, title } of ROW_SOURCES) {
    const row = graph.db
      .prepare(
        `SELECT path, "${title}" AS title, ${table === 'initiative' ? 'slug' : 'initiative'} AS initiative
           FROM "${table}" WHERE "${refColumn}" = ? LIMIT 1`,
      )
      .get(ref) as RowFacts | undefined;
    if (row) return row;
  }
  return null;
}

interface SpanPayload {
  sourceId: number;
  byteOffset: number;
  byteLength: number;
  field?: string;
}

/**
 * The file a span's `source_id` addresses.
 *
 * Workspace spans are offset by `WORKSPACE_SPAN_SOURCE_BASE` so the two halves
 * of one span table cannot collide; below the base is a mined transcript.
 */
function fileForSource(graph: WorkspaceGraph, sourceId: number, activeRoot: string): string | null {
  if (sourceId >= WORKSPACE_SPAN_SOURCE_BASE) {
    const row = graph.db
      .prepare('SELECT source_key FROM workspace_file WHERE source_id = ?')
      .get(sourceId - WORKSPACE_SPAN_SOURCE_BASE) as { source_key: string } | undefined;
    return row ? toAbsolute(activeRoot, row.source_key) : null;
  }
  const row = graph.db
    .prepare('SELECT source_key FROM transcript WHERE source_id = ?')
    .get(sourceId) as { source_key: string } | undefined;
  if (!row) return null;
  return row.source_key.startsWith('~')
    ? path.join(process.env.HOME ?? '', row.source_key.slice(1))
    : row.source_key;
}

/** Collapse to one line and bound the width, so a result list stays readable. */
function oneLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/**
 * Read the matching bytes from the real file.
 *
 * Returns null rather than throwing when the file has moved or shrunk. An index
 * is allowed to be staler than the disk — a pruned transcript is the normal
 * case, not an error — and one unreadable excerpt must not cost a whole search.
 */
async function excerptFor(
  graph: WorkspaceGraph,
  payload: SpanPayload | undefined,
  activeRoot: string,
  width: number,
): Promise<string | null> {
  if (!payload) return null;
  const file = fileForSource(graph, payload.sourceId, activeRoot);
  if (file === null) return null;
  try {
    // The locator's first element names a transcript row; the file is already
    // resolved here, so only the byte range matters.
    const locator = [0, payload.byteOffset, payload.byteLength] as const;
    return oneLine(await readLocatorText(file, locator), width);
  } catch {
    return null;
  }
}

export interface FusedInput {
  id: string;
  score: number;
  sources: string[];
  payloads: Record<string, Record<string, unknown>>;
}

/** The winning span, from whichever class retriever ranked this id best. */
function spanPayload(result: FusedInput): SpanPayload | undefined {
  const first = Object.values(result.payloads)[0];
  return first as unknown as SpanPayload | undefined;
}

export async function resolveHits(
  graph: WorkspaceGraph,
  results: FusedInput[],
  activeRoot: string,
  excerptWidth: number,
): Promise<ResolvedHit[]> {
  return Promise.all(
    results.map(async (result) => {
      const payload = spanPayload(result);
      const row = rowFor(graph, result.id);
      return {
        ref: result.id,
        class: classOf(result.id, payload?.field),
        initiative: row?.initiative ?? null,
        title: row?.title ?? null,
        path: row?.path ?? null,
        excerpt: await excerptFor(graph, payload, activeRoot, excerptWidth),
        score: result.score,
        sources: result.sources,
      };
    }),
  );
}
