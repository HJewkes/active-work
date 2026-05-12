import pc from 'picocolors';

/**
 * Lightweight color wrapper that respects `NO_COLOR` and TTY detection.
 *
 * If `NO_COLOR` is set or stdout is not a TTY (e.g. piped output or test
 * runners), every helper returns its input unchanged so JSON and human
 * output stay free of escape codes when they would only add noise.
 */
const enabled =
  !('NO_COLOR' in process.env) && process.stdout.isTTY === true;

const identity = (s: string): string => s;

export const color = {
  enabled,
  bold: enabled ? pc.bold : identity,
  dim: enabled ? pc.dim : identity,
  green: enabled ? pc.green : identity,
  yellow: enabled ? pc.yellow : identity,
  red: enabled ? pc.red : identity,
  cyan: enabled ? pc.cyan : identity,
  gray: enabled ? pc.gray : identity,
};
