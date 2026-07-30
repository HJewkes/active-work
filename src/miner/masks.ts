import genericMaskConfig from './masks/generic.js';

/**
 * A single typed-mask rule: `pattern`/`flags` build a `RegExp`; every match is
 * replaced with `<name>` in the masked signature, and the first occurrence's
 * matched text is recorded under `extractedParams[name]`.
 */
export interface MaskRule {
  name: string;
  pattern: string;
  flags: string;
}

export interface MaskResult {
  maskedSignature: string;
  extractedParams: Record<string, string>;
}

/**
 * Frozen, checked-in mask configs (§C1 DeepParse bootstrap). Keyed by tool
 * type; unregistered tool types fall back to `generic`. Populating a
 * dedicated `<tool>.json` is a one-time, reviewed action via the (separate,
 * not-yet-built) mask-bootstrap script — never generated at index time.
 */
const MASK_CONFIGS: Record<string, MaskRule[]> = {
  generic: genericMaskConfig,
};

function configFor(toolType: string): MaskRule[] {
  return MASK_CONFIGS[toolType] ?? MASK_CONFIGS.generic;
}

/**
 * Apply `toolType`'s frozen mask rules to a signature line, in rule order,
 * so an earlier rule's replacement text (e.g. `<UUID>`) never gets re-matched
 * by a later, looser rule (e.g. `<NUM>`).
 */
export function applyMasks(toolType: string, signatureLine: string): MaskResult {
  const rules = configFor(toolType);
  const extractedParams: Record<string, string> = {};

  let masked = signatureLine;
  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, rule.flags);
    masked = masked.replace(regex, (match) => {
      if (!(rule.name in extractedParams)) {
        extractedParams[rule.name] = match;
      }
      return `<${rule.name}>`;
    });
  }

  return { maskedSignature: masked, extractedParams };
}
