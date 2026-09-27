import { createRetrievalEngine, ftsRetriever } from '@titan-design/retrieval';
import { openDatabase, SpanFtsTables, spanFtsTablesDdl, type Db } from '@titan-design/store-sqlite';
import type { PrecedentRow } from './schema.js';

/**
 * Rank precedent rows for a query with the same BM25 retriever and fusion
 * engine as workspace search. The index is built in memory per query: the
 * corpus is a few thousand short rows, and keeping it out of the graph keeps
 * conversation text out of any file the miner owns.
 */

export interface PrecedentSearchOptions {
  limit?: number;
  /** Bias towards this initiative. A boost, never a filter, as in `search`. */
  initiative?: string;
  /** Only rows of this class. */
  class?: string;
}

export interface PrecedentHit {
  score: number;
  row: PrecedentRow;
}

const AFFINITY_BOOST = 0.007;
const OWNER_PREFIX = 'precedent:';

function searchableText(row: PrecedentRow): string {
  return [row.header, row.question, row.options.join(' / '), row.answer].filter(Boolean).join('\n');
}

function buildIndex(db: Db, rows: PrecedentRow[]): SpanFtsTables {
  db.exec(spanFtsTablesDdl());
  const spans = new SpanFtsTables(db);
  rows.forEach((row, i) => {
    const span = {
      ownerRef: `${OWNER_PREFIX}${i}`,
      field: 'text',
      sourceId: i,
      byteOffset: 0,
      byteLength: 0,
    };
    spans.index(span, searchableText(row));
  });
  return spans;
}

export async function searchPrecedents(
  rows: PrecedentRow[],
  query: string,
  options: PrecedentSearchOptions = {},
): Promise<PrecedentHit[]> {
  const limit = options.limit ?? 8;
  const pool = options.class === undefined ? rows : rows.filter((r) => r.class === options.class);
  if (pool.length === 0) return [];
  const db = openDatabase(':memory:');
  try {
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(buildIndex(db, pool))] });
    const { results } = await engine.search(query, { limit: limit * 3 });
    return rankHits(pool, results, options.initiative).slice(0, limit);
  } finally {
    db.close();
  }
}

function rankHits(
  pool: PrecedentRow[],
  results: { id: string; score: number }[],
  initiative: string | undefined,
): PrecedentHit[] {
  const hits = results.map((result) => {
    const row = pool[Number(result.id.slice(OWNER_PREFIX.length))];
    const boost = initiative !== undefined && row.initiative === initiative;
    return { score: result.score + (boost ? AFFINITY_BOOST : 0), row };
  });
  return hits.sort((a, b) => b.score - a.score);
}
