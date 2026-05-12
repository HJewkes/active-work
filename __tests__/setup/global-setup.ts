/**
 * Vitest globalSetup hook.
 *
 * Pins `process.env.TZ = 'UTC'` so date/time-sensitive tests are
 * deterministic regardless of where they run. No teardown work for v1.
 */
export default async function setup(): Promise<void> {
  process.env.TZ = 'UTC';
}
