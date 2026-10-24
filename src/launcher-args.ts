/**
 * Pure helpers for assembling the `claude` argv the `aw` launcher spawns.
 * Kept side-effect-free (no top-level `main()`) so they are unit-testable
 * without executing the launcher on import.
 */

/**
 * Merge an initiative's brief-declared channels with a caller-supplied set of
 * defaults (typically the user's global config — see `utils/global-config.ts`).
 * Defaults come first, de-duplicated by exact target string so a brief that
 * redundantly lists a default doesn't double it up on the command line.
 */
export function mergeChannels(
  defaultChannels: string[] | undefined,
  briefChannels: string[] | undefined,
): string[] {
  const merged = [...(defaultChannels ?? []), ...(briefChannels ?? [])];
  return [...new Set(merged)];
}

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
  const targets = channels.map((raw) => (/^(server|plugin):/.test(raw) ? raw : `server:${raw}`));
  const plugins = targets.filter((t) => t.startsWith('plugin:'));
  const servers = targets.filter((t) => !t.startsWith('plugin:'));
  return [
    ...(plugins.length > 0 ? ['--channels', ...plugins] : []),
    ...(servers.length > 0 ? ['--dangerously-load-development-channels', ...servers] : []),
  ];
}

export interface ClaudeArgsOptions {
  /** Start the session with Remote Control; defaults to true for `aw` primary sessions. */
  remoteControl?: boolean;
}

/**
 * Assemble the full `claude` argv. The prompt always follows a `--` so the
 * variadic channel flags can never swallow it as a channel target — the bug
 * that made `aw <slug>` collide the channel name with the bootstrap prompt.
 *
 * `--remote-control` takes an optional name, so it sits directly before `--`
 * where no following token can be read as that name.
 */
export function buildClaudeArgs(
  prompt: string,
  channels?: string[],
  opts: ClaudeArgsOptions = {},
): string[] {
  const remoteControl = opts.remoteControl ?? true;
  return [
    ...buildChannelArgs(channels),
    ...(remoteControl ? ['--remote-control'] : []),
    '--',
    prompt,
  ];
}

/**
 * Assemble the `claude --resume` argv for `aw resume`. A resumed session is a
 * primary session, so it gets Remote Control on the same terms as a launch.
 * The flag goes last, where no following token can be read as its name.
 */
export function buildResumeArgs(sessionId: string, opts: ClaudeArgsOptions = {}): string[] {
  const remoteControl = opts.remoteControl ?? true;
  return ['--resume', sessionId, ...(remoteControl ? ['--remote-control'] : [])];
}

/**
 * `--adhoc` is the canonical spelling; `--ad-hoc` is accepted as an alias so
 * the natural hyphenated form doesn't trip the unknown-flag guard below.
 */
export const ADHOC_FLAGS = ['--adhoc', '--ad-hoc'];

/** Opt out of Remote Control for one launch; `--no-remote-control` is the long alias. */
export const NO_RC_FLAGS = ['--no-rc', '--no-remote-control'];

export const PROFILE_FLAG = '--profile';

export interface ProfileFlag {
  /** The `--profile <name>` / `--profile=<name>` value; the last one given wins. */
  profile?: string;
  /** `args` with every `--profile` occurrence (and its value) removed. */
  rest: string[];
  /** True when `--profile` was given without a name. */
  missingValue: boolean;
}

/** Pull `--profile <name>` and `--profile=<name>` out of an argument list. */
export function extractProfileFlag(args: string[]): ProfileFlag {
  const rest: string[] = [];
  let profile: string | undefined;
  let missingValue = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith(`${PROFILE_FLAG}=`)) {
      profile = arg.slice(PROFILE_FLAG.length + 1);
    } else if (arg === PROFILE_FLAG) {
      profile = args[++i];
    } else {
      rest.push(arg);
      continue;
    }
    missingValue ||= !profile || profile.startsWith('-');
  }
  return { profile: missingValue ? undefined : profile, rest, missingValue };
}

export interface LauncherFlags {
  pick: boolean;
  adhoc: boolean;
  /** False when `--no-rc` (or `--no-remote-control`) was given. */
  remoteControl: boolean;
  /** Claude profile chosen with `--profile`; beats the brief's `profile:`. */
  profile?: string;
  positional: string[];
  /** True when a positional looks like an unknown flag, more than one slug was given, or `--profile` lacks a name. */
  usageError: boolean;
}

/**
 * Parse the `aw` launcher flags out of `argv.slice(2)`. Pure and
 * side-effect-free so the flag handling — including the `--adhoc` / `--ad-hoc`
 * alias — is unit-testable without executing the launcher.
 */
export function parseLauncherFlags(args: string[]): LauncherFlags {
  const { profile, rest, missingValue } = extractProfileFlag(args);
  const known = new Set(['--pick', ...ADHOC_FLAGS, ...NO_RC_FLAGS]);
  const positional = rest.filter((a) => !known.has(a));
  return {
    pick: rest.includes('--pick'),
    adhoc: rest.some((a) => ADHOC_FLAGS.includes(a)),
    remoteControl: !rest.some((a) => NO_RC_FLAGS.includes(a)),
    ...(profile ? { profile } : {}),
    positional,
    usageError: missingValue || positional.some((a) => a.startsWith('-')) || positional.length > 1,
  };
}
