/**
 * Reading registry options back out of commander's parsed opts.
 *
 * Lives apart from `src/cli.ts` because that module invokes `main()` on
 * import and so cannot be pulled into a unit test.
 */

/** commander camelCases long flag names, dropping the leading `--`. */
export function camelizeFlagKey(flagKey: string): string {
  return flagKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Read one registry option out of commander's parsed opts.
 *
 * commander implements `--no-thing` as the *negation* of `--thing`: it stores
 * `false` under `thing` and never defines a `noThing` key at all. A registry
 * flag declared as `--no-x` therefore has to be read back off `x === false`.
 * Reading it by its own name — which is what this used to do — always yielded
 * `undefined`, so every `--no-*` flag silently did nothing when passed on the
 * CLI, while working fine over MCP where args arrive already structured.
 * `wrap --no-loops` shipped broken for exactly this reason.
 *
 * The paired value flag must also ignore that `false`, or `--no-notes` would
 * be handed to `--notes` as a boolean and fail schema validation instead.
 */
export function readCommanderOption(
  opts: Record<string, unknown>,
  long: string,
  flagToKey: (long: string) => string,
): unknown {
  if (long.startsWith('--no-')) {
    const stem = camelizeFlagKey(flagToKey(`--${long.slice('--no-'.length)}`));
    return opts[stem] === false ? true : undefined;
  }
  const flagKey = flagToKey(long);
  const value = opts[camelizeFlagKey(flagKey)] ?? opts[flagKey];
  return value === false ? undefined : value;
}
