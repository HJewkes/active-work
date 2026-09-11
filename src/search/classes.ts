import type { SpanScope } from '@titan-design/store-sqlite';

/**
 * The classes of thing a search ranks, and the prior over them.
 *
 * One pooled FTS query over this database returns transcript chatter and
 * nothing else: measured 2026-09-11, 92,713 transcript spans against 1,569 note
 * spans, 59 to 1. So each class is its own retriever and RRF fuses them. Rank
 * is computed within a list, so a large class only ever contributes its own
 * top-N — that one decision does most of the work here.
 *
 * `weight` and `share` say different things, and the share turned out to be the
 * one that matters. The weight is how much a hit counts once found; the share
 * is how much of one page a class may occupy at all.
 *
 * Measured 2026-09-11 on the live corpus: with shares set, three quite
 * different weight profiles returned byte-identical class mixes across five
 * queries. Without them, every profile returned ten notes and nothing else,
 * because RRF with k=60 compresses ranks so hard that a modest weight gap
 * strictly orders the classes — one class's twentieth result outranks the
 * next class's first. The share is what stops that; the weight only decides
 * order within what is left.
 */
export interface SearchClass {
  name: string;
  scope: SpanScope;
  /** RRF fusion weight. Ordered notes > initiatives > sources > tasks > sessions > transcripts. */
  weight: number;
  /**
   * Most of one result page this class may fill, as a fraction of the limit.
   *
   * A fraction rather than a count, because a cap of five means something
   * different for `--limit 10` than for `--limit 50`. The shares sum above 1
   * on purpose: a page still fills when some classes have no match, but no
   * class alone can fill it.
   */
  share: number;
}

/**
 * `session:` covers two classes, separable only by field.
 *
 * A workspace session record and a mined transcript are both owned by
 * `session:<id>` — deliberately, because that shared key is what makes the
 * cross-class join work. It means a prefix alone cannot tell them apart: the
 * record is the `body` field, the transcript is everything else. A prefix-only
 * scope would put 92,713 transcript spans into the records' list and look like
 * it was working.
 */
const TRANSCRIPT_FIELDS = ['prompt', 'assistant_response', 'tool_input', 'tool_result'];

export const SEARCH_CLASSES: SearchClass[] = [
  { name: 'notes', scope: { ownerPrefix: 'note:' }, weight: 1.3, share: 0.5 },
  // Briefs are the most distilled statement of what an initiative is, and there
  // are only 56 spans of them. The design's table predates the indexer and
  // omits the class; including it costs nothing and makes `brief.md` findable.
  { name: 'initiatives', scope: { ownerPrefix: 'initiative:' }, weight: 1.15, share: 0.2 },
  { name: 'sources', scope: { ownerPrefix: 'source:' }, weight: 1.1, share: 0.3 },
  { name: 'tasks', scope: { ownerPrefix: 'task:' }, weight: 1.0, share: 0.3 },
  // Narrative restatements of the notes, written by the session that wrote
  // them: the workspace's own duplicate content, so low on both counts.
  {
    name: 'sessions',
    scope: { ownerPrefix: 'session:', fields: ['body'] },
    weight: 0.6,
    share: 0.2,
  },
  {
    name: 'transcripts',
    scope: { ownerPrefix: 'session:', fields: TRANSCRIPT_FIELDS },
    weight: 0.45,
    share: 0.2,
  },
];

/** How many candidates a class may contribute for a page of `limit`. */
export function capFor(cls: SearchClass, limit: number): number {
  return Math.max(1, Math.ceil(limit * cls.share));
}

/**
 * Which class a fused id belongs to.
 *
 * Both `sessions` and `transcripts` answer `session:`, so the ref alone is not
 * enough; the winning span's field decides, the same way the scopes do.
 */
export function classOf(ref: string, field?: string): string {
  const prefix = ref.slice(0, ref.indexOf(':'));
  if (prefix !== 'session') return `${prefix}s`;
  return field !== undefined && TRANSCRIPT_FIELDS.includes(field) ? 'transcripts' : 'sessions';
}
