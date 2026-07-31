import { toolTypeFor } from './route.js';
import { hasErrorSignal } from './signature.js';

/**
 * Projects one transcript JSONL line into the tool-result *blobs* the Drain
 * miner clusters (AW-89).
 *
 * Deliberately per-blob, not per-line: `src/miner/index.ts` clusters a whole
 * stdout/stderr blob through one extracted signature line, because feeding
 * Drain a stack trace line-by-line makes recursion depth — not failure shape —
 * the thing it clusters on.
 *
 * Every rule here is a pure function of the single line plus the
 * `tool_use_id -> tool name` map carried forward from earlier lines. That map
 * is the only cross-line state, and the transcript reader persists it with the
 * byte watermark, so resuming mid-transcript sees exactly what a full pass
 * would.
 */

type Json = Record<string, unknown>;

export interface ExtractedBlob {
  /** Drain-tree partition, via `toolTypeFor` on the originating tool name. */
  toolType: string;
  /** stdout+stderr, or the error text — never the surrounding JSON. */
  rawText: string;
  sessionId: string;
  timestamp: string;
  /**
   * Whether this blob is worth clustering (AW-93). A tool result flagged
   * `is_error` always is — the flag *is* the failure signal. Successful command
   * output only is when it carries a recognizable failure shape of its own; see
   * `hasErrorSignal`. Ineligible candidates are still reported, so narrowing is
   * a measured number in the eval scorecard rather than a silent drop.
   */
  eligible: boolean;
}

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(source: Json | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function blocks(line: Json): Json[] {
  const content = asObject(line.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.map(asObject).filter((b): b is Json => b !== null);
}

/** A `tool_result` block's content is either a bare string or text blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => str(asObject(block), 'text') ?? '')
    .filter(Boolean)
    .join('\n');
}

/**
 * The `tool_use_id -> tool name` pairs this line declares. Recorded from
 * assistant lines so the *following* user line's `tool_result` can be routed
 * to the right Drain partition — the result block itself only carries the id.
 */
export function collectToolUses(line: Json): [string, string][] {
  const pairs: [string, string][] = [];
  for (const block of blocks(line)) {
    if (block.type !== 'tool_use') continue;
    const id = str(block, 'id');
    const name = str(block, 'name');
    if (id && name) pairs.push([id, name]);
  }
  return pairs;
}

/**
 * Bash-shaped results carry their output on the line's `toolUseResult`, not
 * inside the `tool_result` block (whose content is a rendered summary). Empty
 * output is not a blob: there is no shape to cluster.
 */
function commandOutput(line: Json): string | null {
  const result = asObject(line.toolUseResult);
  if (!result) return null;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const text = [stdout, stderr].filter((part) => part.trim().length > 0).join('\n');
  return text.length > 0 ? text : null;
}

/**
 * Every candidate blob on one line: each `is_error` tool result, plus the
 * stdout+stderr of a successful command result. Each carries an `eligible`
 * flag; the caller decides what to do with the ineligible ones.
 *
 * A line yields at most one blob per `tool_result` block, and Claude Code
 * emits one result block per user line in practice; the loop is written for
 * the general case anyway so a batched line cannot silently drop blobs.
 */
export function extractBlobs(line: Json, toolNames: Map<string, string>): ExtractedBlob[] {
  const sessionId = str(line, 'sessionId');
  if (!sessionId) return [];
  const timestamp = str(line, 'timestamp');
  if (!timestamp) return [];

  const found: ExtractedBlob[] = [];
  for (const block of blocks(line)) {
    if (block.type !== 'tool_result') continue;
    const id = str(block, 'tool_use_id');
    const toolName = id ? toolNames.get(id) : undefined;
    if (id) toolNames.delete(id);

    const isError = block.is_error === true;
    const rawText = isError ? toolResultText(block.content) : commandOutput(line);
    if (!rawText || rawText.trim().length === 0) continue;

    const toolType = toolTypeFor(toolName ?? '');
    found.push({
      toolType,
      rawText,
      sessionId,
      timestamp,
      eligible: isError || hasErrorSignal(toolType, rawText),
    });
  }
  return found;
}
