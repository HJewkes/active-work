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

/**
 * Candidates to ask each loop for. Other loops can take at most `HITS_TOTAL - 1`
 * of them first, so this many always leaves a loop its own two.
 */
const CANDIDATES_PER_LOOP = HITS_TOTAL + HITS_PER_LOOP - 1;

async function queryLoop(
  input: LoopContextInput,
  index: number,
  context: LoopContext,
): Promise<RelatedHit[]> {
  const retriever = input.retriever ?? relatedContext;
  try {
    const result = await retriever({
      text: input.labels[index]!,
      initiative: input.slug,
      classes: RELATED_DEFAULT_CLASSES,
      limit: CANDIDATES_PER_LOOP,
      budget: CHARS_TOTAL,
      exclude: [...input.shown, ...ownRefs(input.loops[index]!)],
      render: (hit) => renderSeeLine(hit, input.slug) + '\n',
    });
    addDegraded(context, result.degraded);
    return result.hits;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addDegraded(context, [{ source: 'loop-retriever', reason: 'error', message }]);
    return [];
  }
}

function addDegraded(context: LoopContext, entries: RelatedDegradation[]): void {
  for (const entry of entries) {
    const seen = context.degraded.some(
      (known) => known.source === entry.source && known.message === entry.message,
    );
    if (!seen) context.degraded.push(entry);
  }
}

interface Allocation {
  hits: number;
  chars: number;
  taken: Set<string>;
}

/** False once the budget is spent; a hit that would overflow ends allocation rather than being skipped. */
function allocateOne(
  loop: OpenLoop,
  candidates: RelatedHit[],
  context: LoopContext,
  allocation: Allocation,
  slug: string,
): boolean {
  const hit = candidates.find((candidate) => !allocation.taken.has(candidate.ref));
  if (hit === undefined) return true;
  const cost = renderSeeLine(hit, slug).length + 1;
  if (allocation.hits === 0 || cost > allocation.chars) return false;
  const lines = context.hits.get(loop.ref) ?? [];
  context.hits.set(loop.ref, [...lines, { ...hit, rank: lines.length + 1 }]);
  allocation.taken.add(hit.ref);
  allocation.hits -= 1;
  allocation.chars -= cost;
  return true;
}

/**
 * Round-robin over the loops: every loop's best hit first, then second hits.
 *
 * Seven loops therefore get six one-line annotations rather than three loops
 * getting two each, and a loop whose best hit an earlier loop already took
 * still gets its next one in the first pass.
 */
export async function relatedForLoops(input: LoopContextInput): Promise<LoopContext> {
  const context: LoopContext = { hits: new Map(), degraded: [] };
  const candidates: RelatedHit[][] = [];
  for (let i = 0; i < input.loops.length; i++) candidates.push(await queryLoop(input, i, context));
  const allocation: Allocation = { hits: HITS_TOTAL, chars: CHARS_TOTAL, taken: new Set() };
  for (let pass = 0; pass < HITS_PER_LOOP; pass++) {
    for (let i = 0; i < input.loops.length; i++) {
      const loop = input.loops[i]!;
      if ((context.hits.get(loop.ref)?.length ?? 0) !== pass) continue;
      if (!allocateOne(loop, candidates[i]!, context, allocation, input.slug)) return context;
    }
  }
  return context;
}
