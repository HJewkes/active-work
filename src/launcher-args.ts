/**
 * Pure helpers for assembling the `claude` argv the `aw` launcher spawns.
 * Kept side-effect-free (no top-level `main()`) so they are unit-testable
 * without executing the launcher on import.
 */

/**
 * Build the `--dangerously-load-development-channels` flag for an initiative's
 * MCP push channels.
 *
 * Each frontmatter `channels` entry is a target: an explicit
 * `server:<name>` / `plugin:<name>@<marketplace>`, or a bare server name that
 * is normalized to `server:<name>`. All targets are passed under a single
 * variadic flag (still required as of Claude Code v2.1.197 — there is no
 * config-file equivalent).
 */
export function buildChannelArgs(channels: string[] | undefined): string[] {
  if (!channels || channels.length === 0) return [];
  const targets = channels.map((raw) =>
    /^(server|plugin):/.test(raw) ? raw : `server:${raw}`,
  );
  return ['--dangerously-load-development-channels', ...targets];
}

/**
 * Assemble the full `claude` argv. The prompt always follows a `--` so the
 * variadic channels flag can never swallow it as a channel target — the bug
 * that made `aw <slug>` collide the channel name with the bootstrap prompt.
 */
export function buildClaudeArgs(prompt: string, channels?: string[]): string[] {
  return [...buildChannelArgs(channels), '--', prompt];
}
