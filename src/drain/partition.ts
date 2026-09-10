/**
 * Which Drain partition a Claude Code tool result belongs to.
 *
 * `@titan-design/cluster` partitions by an opaque key and has no opinion about
 * what a partition means; this is active-work's mapping from a `tool_use` name
 * to one. Route before Drain sees a line, so a `tsc` failure and a `vitest`
 * failure never end up in the same cluster just because their token shapes
 * happen to overlap.
 */

export type ToolType = 'Bash' | 'Read' | 'Edit' | 'generic';

const KNOWN_TOOL_TYPES: Record<string, ToolType> = {
  Bash: 'Bash',
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'Edit',
};

/** Map a Claude Code tool_use name to its Drain-tree partition. */
export function toolTypeFor(toolName: string): ToolType {
  return KNOWN_TOOL_TYPES[toolName] ?? 'generic';
}
