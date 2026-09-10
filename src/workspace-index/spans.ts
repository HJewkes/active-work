/**
 * Locators, not text.
 *
 * The kit's FTS5 table is genuinely contentless: a span row stores a byte range
 * into the source and the index streams the text in and discards it. That is
 * the invariant that makes this whole index throwaway — the file stays the only
 * copy of its own content — so every span produced here has to carry a byte
 * range that still opens the right bytes.
 */

export interface IndexedSpan {
  /** Which part of the record, e.g. `title` or `body`. */
  field: string;
  text: string;
  byteOffset: number;
  byteLength: number;
}

const FRONTMATTER_FENCE = /^---\r?\n/;
const FRONTMATTER_END = /^---[ \t]*\r?$/;

/**
 * Byte offset at which a frontmatter file's body starts, or 0 for a file with
 * no frontmatter. `gray-matter` hands back the parsed body but not where it
 * began, and "where it began" is the entire content of a locator.
 */
export function bodyByteOffset(raw: string): number {
  if (!FRONTMATTER_FENCE.test(raw)) return 0;
  const lines = raw.split('\n');
  let consumed = lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    consumed += lines[i].length + 1;
    if (FRONTMATTER_END.test(lines[i])) return Buffer.byteLength(raw.slice(0, consumed), 'utf8');
  }
  return 0;
}

/** A locator covering the whole file, for a value YAML reflowed beyond recognition. */
export function wholeFile(raw: string): { byteOffset: number; byteLength: number } {
  return { byteOffset: 0, byteLength: Buffer.byteLength(raw, 'utf8') };
}

/**
 * Point a span at the exact bytes of `text` when the file contains it verbatim,
 * and at the whole file when it does not. YAML folds long scalars across lines,
 * so a task title or `done_when` frequently has no literal occurrence; a coarse
 * locator that still resolves beats a precise one that does not.
 */
export function locate(raw: string, field: string, text: string): IndexedSpan | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const at = raw.indexOf(trimmed);
  if (at < 0) return { field, text: trimmed, ...wholeFile(raw) };
  return {
    field,
    text: trimmed,
    byteOffset: Buffer.byteLength(raw.slice(0, at), 'utf8'),
    byteLength: Buffer.byteLength(trimmed, 'utf8'),
  };
}

/**
 * Split a markdown body into one span per heading section.
 *
 * Section-sized spans are what the design's own span estimates assume — roughly
 * three per note, ten per session record, twenty per source — and they are what
 * makes a hit resolve to a readable excerpt rather than to an entire session
 * write-up.
 */
export function sectionSpans(body: string, baseByteOffset: number, field = 'body'): IndexedSpan[] {
  const spans: IndexedSpan[] = [];
  let cursor = baseByteOffset;
  for (const section of splitOnHeadings(body)) {
    const byteLength = Buffer.byteLength(section, 'utf8');
    if (section.trim().length > 0) {
      spans.push({ field, text: section, byteOffset: cursor, byteLength });
    }
    cursor += byteLength;
  }
  return spans;
}

/** Sections keep their own trailing text, so concatenating them reproduces the body exactly. */
function splitOnHeadings(body: string): string[] {
  const lines = body.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n') + '\n');
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections;
}
