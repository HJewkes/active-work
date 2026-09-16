import type { OpenLoop } from '../sessions/open-loops.js';
import {
  RELATED_DEFAULT_CLASSES,
  relatedContext,
  type RelatedDegradation,
  type RelatedHit,
  type RelatedInput,
  type RelatedResult,
} from '../search/related.js';

/**
 * What the workspace already knows about each open loop (TP-85).
 *
 * A loop is an unfinished thread, and the text that describes it is already a
 * query; nobody has to think to search. The notes section answers a different
 * question (what bears on the top task), so a hit it already shows is excluded
 * here rather than printed twice.
 */

export type LoopRetriever = (input: RelatedInput) => Promise<RelatedResult>;

/** Two per loop, six and 1,200 rendered characters across all of them (design §2). */
const HITS_PER_LOOP = 2;
const HITS_TOTAL = 6;
const CHARS_TOTAL = 1200;

export interface LoopHit extends RelatedHit {
  /** 1-based within this loop's lines. */
  rank: number;
}

export interface LoopContext {
  /** Keyed by loop ref. A loop with no hits has no entry. */
  hits: Map<string, LoopHit[]>;
  degraded: RelatedDegradation[];
}

export interface LoopContextInput {
  loops: OpenLoop[];
  /** Each loop's rendered label, the query it is searched with. Parallel to `loops`. */
  labels: string[];
  slug: string;
  /** Refs rendered elsewhere in the prompt. */
  shown: string[];
  retriever?: LoopRetriever;
}

export function renderSeeLine(hit: RelatedHit, slug: string): string {
  const foreign =
    hit.initiative !== null && hit.initiative !== slug ? `[from \`${hit.initiative}\`] ` : '';
  return `    see: ${foreign}${hit.ref} "${hit.title ?? hit.ref}"`;
}

/** The loop's own session record and the task it targets are what the loop already is. */
function ownRefs(loop: OpenLoop): string[] {
  const refs = [`session:${loop.sessionId}`];
  if (loop.kind === 'task' && loop.targetRef !== undefined) {
    refs.push(`task:${loop.targetRef.toUpperCase()}`);
  }
  return refs;
}

interface Remaining {
  hits: number;
  chars: number;
  excluded: Set<string>;
}

async function queryLoop(
  input: LoopContextInput,
  index: number,
  remaining: Remaining,
): Promise<RelatedResult> {
  const loop = input.loops[index]!;
  const retriever = input.retriever ?? relatedContext;
  return retriever({
    text: input.labels[index]!,
    initiative: input.slug,
    classes: RELATED_DEFAULT_CLASSES,
    limit: Math.min(HITS_PER_LOOP, remaining.hits),
    budget: remaining.chars,
    exclude: [...remaining.excluded, ...ownRefs(loop)],
    render: (hit) => renderSeeLine(hit, input.slug) + '\n',
  });
}

/** Stop at the first hit that would overflow, so the budget never reorders what ranked. */
function take(result: RelatedResult, slug: string, remaining: Remaining): LoopHit[] {
  const taken: LoopHit[] = [];
  for (const hit of result.hits) {
    if (taken.length === HITS_PER_LOOP || remaining.hits === 0) break;
    if (remaining.excluded.has(hit.ref)) continue;
    const cost = renderSeeLine(hit, slug).length + 1;
    if (cost > remaining.chars) break;
    remaining.chars -= cost;
    remaining.hits -= 1;
    remaining.excluded.add(hit.ref);
    taken.push({ ...hit, rank: taken.length + 1 });
  }
  return taken;
}

function addDegraded(context: LoopContext, entries: RelatedDegradation[]): void {
  for (const entry of entries) {
    const seen = context.degraded.some(
      (known) => known.source === entry.source && known.message === entry.message,
    );
    if (!seen) context.degraded.push(entry);
  }
}

/** Loops are queried in render order, so the oldest loops get first claim on the budget. */
export async function relatedForLoops(input: LoopContextInput): Promise<LoopContext> {
  const context: LoopContext = { hits: new Map(), degraded: [] };
  const remaining: Remaining = {
    hits: HITS_TOTAL,
    chars: CHARS_TOTAL,
    excluded: new Set(input.shown),
  };
  for (let i = 0; i < input.loops.length && remaining.hits > 0 && remaining.chars > 0; i++) {
    let result: RelatedResult;
    try {
      result = await queryLoop(input, i, remaining);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addDegraded(context, [{ source: 'loop-retriever', reason: 'error', message }]);
      continue;
    }
    addDegraded(context, result.degraded);
    const hits = take(result, input.slug, remaining);
    if (hits.length > 0) context.hits.set(input.loops[i]!.ref, hits);
  }
  return context;
}
