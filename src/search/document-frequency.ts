import type { WorkspaceGraph } from '../session-index/graph.js';
import type { DocumentFrequency } from './derive-query.js';
import { orExpression } from './terms.js';

/**
 * A cheap document frequency off the span index: matching spans, capped.
 *
 * The store kit exposes no term statistics. Distinct owners among the first N
 * spans was tried first and misranked: a common word whose best spans sit in a
 * few long transcripts counts as rare, which picked `work` and `active` over
 * `introspection` on a live loop. A capped span count is monotone up to the
 * cap, and past it a term is too common for the exact count to matter.
 */
const SPAN_CAP = 2000;

/** Per database file, for the life of the process; the daemon keeps one graph open. */
const cache = new Map<string, Map<string, number>>();

/** Bounded so a long-lived daemon cannot grow the cache without limit. */
const CACHE_TERMS = 20_000;

function countSpans(graph: WorkspaceGraph, term: string): number {
  return graph.spans.search(orExpression([term]), SPAN_CAP).length;
}

export function graphDocumentFrequency(graph: WorkspaceGraph): DocumentFrequency {
  const key = graph.db.name;
  const counts = cache.get(key) ?? new Map<string, number>();
  cache.set(key, counts);
  return (term) => {
    const known = counts.get(term);
    if (known !== undefined) return known;
    if (counts.size >= CACHE_TERMS) counts.clear();
    const count = countSpans(graph, term);
    counts.set(term, count);
    return count;
  };
}
