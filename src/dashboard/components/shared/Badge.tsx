/**
 * Unified pill badge, ported from brain's dashboard shared components and
 * adapted to active-work's own tokens. Brain splits this into Badge+Pill;
 * folded into one file here since active-work has no other Pill consumer.
 */
import React from 'react';
import { View, Text } from 'react-native';
import { typography } from '../../tokens.js';

export interface BadgeProps {
  label: string;
  /** Semantic color used for text, dot, border, and tinted background. */
  color: string;
  /** Background opacity multiplier, default 0.12. */
  bgOpacity?: number;
  /** Border opacity multiplier, default 0.25. */
  borderOpacity?: number;
  /** Show a status dot before the label, default false. */
  dot?: boolean;
  /** Font size tier: sm=9px, md=10px (default md). */
  size?: 'sm' | 'md';
}

const SIZE_PRESETS = {
  sm: { fontSize: 9, paddingH: 4, paddingV: 1 },
  md: { fontSize: 10, paddingH: 8, paddingV: 2 },
} as const;

export function Badge({
  label,
  color,
  bgOpacity = 0.12,
  borderOpacity = 0.25,
  dot = false,
  size = 'md',
}: BadgeProps): React.JSX.Element {
  const preset = SIZE_PRESETS[size];
  const dotSize = 6;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderWidth: 1,
        borderRadius: 99,
        flexShrink: 0,
        alignSelf: 'flex-start',
        backgroundColor: hexToRgba(color, bgOpacity),
        borderColor: hexToRgba(color, borderOpacity),
        paddingHorizontal: preset.paddingH,
        paddingVertical: preset.paddingV,
      }}
    >
      {dot && (
        <View
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: color,
            flexShrink: 0,
          }}
        />
      )}
      <Text
        style={{
          fontFamily: typography.body,
          fontWeight: '600',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color,
          fontSize: preset.fontSize,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * Convert a hex color string to an rgba() string with the given opacity.
 * Handles 3-digit and 6-digit hex. Falls back to the original value if
 * the input is already an rgba/rgb string or cannot be parsed.
 */
function hexToRgba(color: string, opacity: number): string {
  const hex = color.trim();
  const match6 = hex.match(/^#([0-9a-f]{6})$/i);
  if (match6) {
    const n = parseInt(match6[1], 16);
    return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${opacity})`;
  }
  const match3 = hex.match(/^#([0-9a-f]{3})$/i);
  if (match3) {
    const [r, g, b] = match3[1].split('').map((c) => parseInt(c + c, 16));
    return `rgba(${r},${g},${b},${opacity})`;
  }
  return hex;
}
