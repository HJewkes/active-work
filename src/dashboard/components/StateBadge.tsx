import React from 'react';
import { palette, radii, sp, stateColor, severityColor } from '../tokens.js';

interface Props {
  /** Lower-case state token — focused / backburner / paused / done, or a severity. */
  label: string;
  /** Optional palette override (e.g. severity color). */
  color?: string;
}

/**
 * Small color-coded pill. Uses the state-or-severity color table by
 * default. The accent color is rendered both as a left dot and a tinted
 * background so the badge stays readable on the dark surface.
 */
export function StateBadge({ label, color }: Props): React.JSX.Element {
  const c = color ?? stateColor[label] ?? severityColor[label] ?? palette.gray;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: sp[2],
        padding: `${sp[1]}px ${sp[5]}px`,
        borderRadius: radii.full,
        background: `${c}22`,
        border: `1px solid ${c}55`,
        color: c,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: radii.full,
          background: c,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
}
