/**
 * Generic bordered panel, ported from brain's dashboard shared components
 * (`packages` sibling repo) and adapted to active-work's own tokens.
 */
import React from 'react';
import { View } from 'react-native';
import { palette, radii } from '../../tokens.js';

export interface CardProps {
  children: React.ReactNode;
  variant?: 'plain' | 'accent' | 'subtle';
  accentColor?: string;
  accentWidth?: number;
  borderColor?: string;
  bg?: string;
  padding?: number;
  radius?: number;
}

export function Card({
  children,
  variant = 'plain',
  accentColor,
  accentWidth = 3,
  borderColor,
  bg,
  padding = 10,
  radius = radii.md,
}: CardProps): React.JSX.Element {
  const resolvedBorder = borderColor ?? palette.border;

  const baseStyle = {
    borderRadius: radius,
    padding,
    borderWidth: 1,
    borderColor: resolvedBorder,
  };

  if (variant === 'accent') {
    const accent = accentColor ?? palette.brand;
    return (
      <View
        style={{
          ...baseStyle,
          backgroundColor: bg ?? palette.surface2,
          borderLeftWidth: accentWidth,
          borderLeftColor: accent,
        }}
      >
        {children}
      </View>
    );
  }

  if (variant === 'subtle') {
    const accent = accentColor ?? palette.brand;
    return (
      <View
        style={{
          ...baseStyle,
          backgroundColor: bg ?? palette.surface1,
          borderColor: borderColor ?? `${accent}40`,
        }}
      >
        {children}
      </View>
    );
  }

  // plain
  return (
    <View
      style={{
        ...baseStyle,
        backgroundColor: bg ?? palette.surface2,
      }}
    >
      {children}
    </View>
  );
}
