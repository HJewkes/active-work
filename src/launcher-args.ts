/**
 * Pure helpers for assembling the `claude` argv the `aw` launcher spawns.
 * Kept side-effect-free (no top-level `main()`) so they are unit-testable
 * without executing the launcher on import.
 */

/**
 * Build the channel flags for an initiative's MCP push channels.
 *
 * Each frontmatter `channels` entry is a target: an explicit
 * `server:<name>` / `plugin:<name>@<marketplace>`, or a bare server name that
 * is normalized to `server:<name>`.
 *
 * The two target kinds take different flags, and the choice is not cosmetic.
 * Claude Code's channel gate only has an allowlist path for plugin targets:
 * `plugin:` entries go under `--channels`, which is satisfied by an
 * `allowedChannelPlugins` entry in managed settings, while `server:` entries
 * have no allowlist path at all and must use the dev flag. Routing a properly
 * allowlisted plugin through the dev flag still works, but re-triggers the
 * development-channels dialog that packaging it as a plugin exists to avoid.
 *
 * Both flags are variadic, so callers must keep the prompt behind a `--`.
 */
export function buildChannelArgs(channels: string[] | undefined): string[] {
  if (!channels || channels.length === 0) return [];
  const targets = channels.map((raw) =>
    /^(server|plugin):/.test(raw) ? raw : `server:${raw}`,
  );
  const plugins = targets.filter((t) => t.startsWith('plugin:'));
  const servers = targets.filter((t) => !t.startsWith('plugin:'));
  return [
    ...(plugins.length > 0 ? ['--channels', ...plugins] : []),
    ...(servers.length > 0
      ? ['--dangerously-load-development-channels', ...servers]
      : []),
  ];
}

/**
 * Assemble the full `claude` argv. The prompt always follows a `--` so the
 * variadic channel flags can never swallow it as a channel target — the bug
 * that made `aw <slug>` collide the channel name with the bootstrap prompt.
 */
export function buildClaudeArgs(prompt: string, channels?: string[]): string[] {
  return [...buildChannelArgs(channels), '--', prompt];
}
