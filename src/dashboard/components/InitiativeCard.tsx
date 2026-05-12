import React from 'react';
import { palette, radii, sp, typography } from '../tokens.js';
import { StateBadge } from './StateBadge.js';
import type { InitiativeItem } from '../types.js';

interface Props {
  item: InitiativeItem;
}

/** Read-only card primitive for a single initiative. */
export function InitiativeCard({ item }: Props): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: sp[3],
        padding: sp[8],
        background: palette.surface1,
        border: `1px solid ${palette.border}`,
        borderRadius: radii.md,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: sp[6],
          alignItems: 'flex-start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: sp[2] }}>
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: palette.textPrimary,
            }}
          >
            {item.title}
          </span>
          <span
            style={{
              fontFamily: typography.mono,
              fontSize: 11,
              color: palette.textTertiary,
            }}
          >
            {item.slug}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: sp[2],
          }}
        >
          <StateBadge label={item.state} />
          {item.rank !== undefined && (
            <span
              style={{
                fontFamily: typography.mono,
                fontSize: 11,
                color: palette.brand,
                background: `${palette.brand}1a`,
                padding: `${sp[1]}px ${sp[4]}px`,
                borderRadius: radii.sm,
              }}
            >
              rank {item.rank}
            </span>
          )}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          gap: sp[8],
          fontSize: 12,
          color: palette.textSecondary,
        }}
      >
        {item.ship_target && (
          <span>
            <span style={{ color: palette.textTertiary }}>ship </span>
            {item.ship_target}
          </span>
        )}
        {item.paused_since && (
          <span>
            <span style={{ color: palette.textTertiary }}>paused </span>
            {item.paused_since}
          </span>
        )}
        <span>
          <span style={{ color: palette.textTertiary }}>updated </span>
          {item.updated}
        </span>
      </div>
    </div>
  );
}
