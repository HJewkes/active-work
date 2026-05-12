/**
 * Design tokens for the active-work dashboard.
 *
 * Inspired by brain's tokens but pared down — we only need the palette
 * surface area required by the three read-only views.
 */

export const palette = {
  bg: '#101010',
  surface1: '#161616',
  surface2: '#1c1c1c',
  surface3: '#222222',
  border: '#2a2a2a',
  borderStrong: '#3a3a3a',

  textPrimary: '#f3f4f6',
  textSecondary: '#9ca3af',
  textTertiary: '#6b7280',

  brand: '#ff7900',
  teal: '#14b8a6',
  red: '#f83030',
  amber: '#f4a736',
  gold: '#d4a520',
  blue: '#2196f3',
  steel: '#406d87',
  green: '#22c55e',
  purple: '#a855f7',
  gray: '#9ca3af',
} as const;

/** State -> color mapping for initiative state badges. */
export const stateColor: Record<string, string> = {
  focused: palette.brand,
  backburner: palette.steel,
  paused: palette.amber,
  done: palette.teal,
};

/** Severity -> color mapping for task severity badges. */
export const severityColor: Record<string, string> = {
  critical: palette.red,
  high: palette.amber,
  medium: palette.gold,
  low: palette.blue,
};

export const spacing = {
  1: 2,
  2: 4,
  3: 6,
  4: 8,
  5: 10,
  6: 12,
  7: 14,
  8: 16,
  10: 20,
  12: 24,
  16: 32,
} as const;

export const sp = spacing;

export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
  full: 9999,
} as const;

export const typography = {
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  body:
    '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
} as const;
