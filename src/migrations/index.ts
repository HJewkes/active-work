import { ConfigError } from '../errors.js';
import type { Migration } from './types.js';
import { v1ToV2Artifacts } from './v1-to-v2-artifacts.js';

export type { Migration } from './types.js';

/**
 * The schema version this build of the code expects.
 *
 * Bump this whenever the on-disk layout changes, and add a matching
 * entry to {@link MIGRATIONS} that walks data from the previous version
 * to the new one.
 */
export const CURRENT_VERSION = 2;

/**
 * Migrations registry. Add an entry when bumping {@link CURRENT_VERSION}.
 * Keep entries sorted by `from` ascending.
 *
 * v1 is the baseline. There is intentionally no v0 -> v1 migrator: the
 * plan's fresh-start policy says v0 data is not auto-migrated. Setup
 * stamps `CURRENT_VERSION` on first run; an existing `.schema-version`
 * file containing `0` is treated as an error so the user notices.
 */
export const MIGRATIONS: Migration[] = [v1ToV2Artifacts];

/**
 * Runs every migrator needed to bring `activeRoot` from `fromVersion`
 * to {@link CURRENT_VERSION}. Throws {@link ConfigError} if no
 * contiguous chain exists, or if `fromVersion` is newer than what this
 * build understands.
 *
 * The `migrations` parameter exists for dependency injection in tests;
 * production callers should rely on the default.
 */
export async function runMigrations(
  activeRoot: string,
  fromVersion: number,
  migrations: Migration[] = MIGRATIONS,
): Promise<{ ran: Migration[] }> {
  if (fromVersion === CURRENT_VERSION) {
    return { ran: [] };
  }

  if (fromVersion > CURRENT_VERSION) {
    throw new ConfigError(
      `Schema version ${fromVersion} is newer than this build (${CURRENT_VERSION}); ` +
        `downgrade not supported. Upgrade the active-work CLI to match.`,
    );
  }

  const ran: Migration[] = [];
  let cursor = fromVersion;

  while (cursor < CURRENT_VERSION) {
    const next = migrations.find((m) => m.from === cursor);
    if (!next) {
      throw new ConfigError(
        `No migration registered from schema version ${cursor} to ${CURRENT_VERSION}. ` +
          `Gap at v${cursor} -> v${cursor + 1}.`,
      );
    }
    if (next.to <= next.from) {
      throw new ConfigError(
        `Invalid migration: ${next.description} (from=${next.from}, to=${next.to}) does not advance the version.`,
      );
    }
    await next.run(activeRoot);
    ran.push(next);
    cursor = next.to;
  }

  if (cursor !== CURRENT_VERSION) {
    throw new ConfigError(
      `Migration chain ended at v${cursor}, expected v${CURRENT_VERSION}.`,
    );
  }

  return { ran };
}
