import { ConfigError } from '../errors.js';
import type { Migration } from './types.js';
import { v1ToV2Artifacts } from './v1-to-v2-artifacts.js';
import { v2ToV3OpenLoops } from './v2-to-v3-open-loops.js';
import { v3ToV4Worktrees } from './v3-to-v4-worktrees.js';

export type { Migration } from './types.js';

/**
 * The oldest version this build migrates from.
 *
 * v1 is the baseline. There is intentionally no v0 -> v1 migrator: the
 * plan's fresh-start policy says v0 data is not auto-migrated. Setup
 * stamps {@link CURRENT_VERSION} on first run; an existing
 * `.schema-version` file containing `0` is treated as an error so the
 * user notices.
 */
export const BASE_VERSION = 1;

/**
 * Migrations registry. Add an entry when the on-disk layout changes.
 * Keep entries sorted by `from` ascending.
 */
export const MIGRATIONS: readonly Migration[] = [v1ToV2Artifacts, v2ToV3OpenLoops, v3ToV4Worktrees];

/**
 * The schema version this build expects, derived from the chain rather
 * than hand-maintained (TP-35): adding a migrator is the only way to
 * move it, so the constant and the list cannot disagree.
 */
export const CURRENT_VERSION = targetVersion(MIGRATIONS);

function targetVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((highest, m) => Math.max(highest, m.to), BASE_VERSION);
}

/**
 * Everything wrong with a migration chain, as readable lines; empty means
 * it walks {@link BASE_VERSION} to its target in single steps with no
 * duplicate or missing version. Exported so a test can assert the shipped
 * chain, which is what stops a bad merge resolution reaching a release.
 */
export function chainProblems(migrations: readonly Migration[] = MIGRATIONS): string[] {
  const problems: string[] = [];
  const byFrom = new Map<number, Migration[]>();
  for (const m of migrations) {
    if (m.to <= m.from) {
      problems.push(`${m.description} does not advance the version (from=${m.from}, to=${m.to})`);
    }
    byFrom.set(m.from, [...(byFrom.get(m.from) ?? []), m]);
  }
  for (const [from, group] of byFrom) {
    if (group.length > 1) {
      const names = group.map((m) => m.description).join(', ');
      problems.push(`v${from} has ${group.length} migrations, expected one: ${names}`);
    }
  }
  problems.push(...gaps(byFrom, targetVersion(migrations)));
  return problems;
}

function gaps(byFrom: Map<number, Migration[]>, target: number): string[] {
  let cursor = BASE_VERSION;
  while (cursor < target) {
    const next = byFrom.get(cursor)?.[0];
    if (!next) return [`no migration from v${cursor}; the chain stops short of v${target}`];
    // Guards the walk as well as the chain: a non-advancing step would loop here.
    if (next.to <= cursor) return [`${next.description} cannot advance past v${cursor}`];
    cursor = next.to;
  }
  return [];
}

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
  migrations: readonly Migration[] = MIGRATIONS,
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
    throw new ConfigError(`Migration chain ended at v${cursor}, expected v${CURRENT_VERSION}.`);
  }

  return { ran };
}
