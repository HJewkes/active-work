import type { MaskRule } from '../masks.js';

/**
 * Generic fallback mask config, used for any tool type without a dedicated
 * frozen config. A per-tool config (`Bash.ts`, `test.ts`, …) is produced by
 * the DeepParse mask-bootstrap script (§C1) — a one-time, reviewed action,
 * not yet built. Order matters: earlier rules run first, so their
 * replacement placeholders (`<UUID>`) never get re-matched by a later,
 * looser rule (`<NUM>`).
 */
const genericMaskConfig: MaskRule[] = [
  {
    name: 'UUID',
    pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
    flags: 'gi',
  },
  { name: 'SHA', pattern: '\\b[0-9a-f]{7,40}\\b', flags: 'gi' },
  { name: 'PATH', pattern: '(?:\\.{0,2}/)?(?:[\\w.-]+/)+[\\w.-]+', flags: 'g' },
  {
    name: 'DURATION',
    pattern: '\\b\\d+(?:\\.\\d+)?\\s?(?:ms|s|sec|seconds|min)\\b',
    flags: 'gi',
  },
  { name: 'LINENO', pattern: ':\\d+:\\d+\\b', flags: 'g' },
  {
    name: 'EXITCODE',
    pattern: '\\b(?:exit code|exit status)[: ]+\\d+\\b',
    flags: 'gi',
  },
  { name: 'NUM', pattern: '\\d+', flags: 'g' },
];

export default genericMaskConfig;
