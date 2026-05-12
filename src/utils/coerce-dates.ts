/**
 * YAML parsers (js-yaml inside gray-matter; the `yaml` package) parse bare
 * ISO 8601 timestamps into JavaScript Date instances by default. Our zod
 * schemas validate dates as YYYY-MM-DD or ISO 8601 STRINGS — so we re-coerce
 * any Date we find back into the appropriate string form before validation.
 *
 * A midnight-UTC Date round-trips as YYYY-MM-DD; any non-midnight Date
 * round-trips as the full ISO 8601 string. The heuristic matches the two
 * schema shapes we have (date-only fields like `updated`, ISO fields like
 * `started`/`ended`/`last_checked`).
 */

function dateToString(d: Date): string {
  if (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  ) {
    return d.toISOString().slice(0, 10);
  }
  return d.toISOString();
}

export function coerceDates(value: unknown): unknown {
  if (value instanceof Date) {
    return dateToString(value);
  }
  if (Array.isArray(value)) {
    return value.map(coerceDates);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = coerceDates(v);
    }
    return out;
  }
  return value;
}
