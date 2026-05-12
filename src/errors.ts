/**
 * Typed error hierarchy + sysexits exit codes.
 *
 * EXIT codes follow BSD `sysexits.h` so the CLI dispatcher and JSON envelope
 * surface a consistent, machine-readable status across human and tooling output.
 */

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 64, // EX_USAGE
  DATAERR: 65, // EX_DATAERR — invalid input data / validation
  NOINPUT: 66, // EX_NOINPUT — file/initiative not found
  UNAVAILABLE: 69, // EX_UNAVAILABLE — daemon unreachable
  SOFTWARE: 70, // EX_SOFTWARE — internal bug
  CONFIG: 78, // EX_CONFIG — bad config
} as const;

export class ActiveWorkError extends Error {
  readonly code: number = EXIT.GENERIC;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ActiveWorkError';
  }
}

export class ValidationError extends ActiveWorkError {
  override readonly code: number = EXIT.DATAERR;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends ActiveWorkError {
  override readonly code: number = EXIT.NOINPUT;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NotFoundError';
  }
}

export class UsageError extends ActiveWorkError {
  override readonly code: number = EXIT.USAGE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UsageError';
  }
}

export class DaemonError extends ActiveWorkError {
  override readonly code: number = EXIT.UNAVAILABLE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DaemonError';
  }
}

export class ConfigError extends ActiveWorkError {
  override readonly code: number = EXIT.CONFIG;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

export class SoftwareError extends ActiveWorkError {
  override readonly code: number = EXIT.SOFTWARE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SoftwareError';
  }
}

export function isActiveWorkError(err: unknown): err is ActiveWorkError {
  return err instanceof ActiveWorkError;
}

export function formatError(err: unknown): { message: string; code: number } {
  if (err instanceof ActiveWorkError) {
    return { message: err.message, code: err.code };
  }
  if (err instanceof Error) {
    return { message: err.message, code: EXIT.GENERIC };
  }
  return { message: String(err), code: EXIT.GENERIC };
}
