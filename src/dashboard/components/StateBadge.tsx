import React from 'react';
import { palette, stateColor, severityColor } from '../tokens.js';
import { Badge } from './shared/Badge.js';

interface Props {
  /** Lower-case state token — focused / backburner / paused / done, or a severity. */
  label: string;
  /** Optional palette override (e.g. severity color). */
  color?: string;
}

/**
 * Small color-coded pill. Uses the state-or-severity color table by
 * default. Thin wrapper over the shared `Badge` primitive.
 */
export function StateBadge({ label, color }: Props): React.JSX.Element {
  const c = color ?? stateColor[label] ?? severityColor[label] ?? palette.gray;
  return <Badge label={label} color={c} dot />;
}
