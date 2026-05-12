/**
 * Shared contracts for the schema migration runner.
 *
 * A `Migration` describes a single forward step from one schema version
 * to the next. Migrations chain via matching `to` -> `from` pairs.
 */
export interface Migration {
  /** Schema version this migrator upgrades *from*. */
  from: number;
  /** Schema version this migrator upgrades *to*. Must be `> from`. */
  to: number;
  /** Human-readable summary of what changes. */
  description: string;
  /**
   * Runs the upgrade. Implementations must be idempotent — re-running on
   * already-migrated data should leave it unchanged (or throw a clear
   * error). Operates directly on the given `activeRoot`.
   */
  run(activeRoot: string): Promise<void>;
}
