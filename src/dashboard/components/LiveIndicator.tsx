import React from 'react';
import { palette, sp } from '../tokens.js';
import type { LiveStatus } from '../utils/live.js';

const LABELS: Record<LiveStatus, { text: string; color: string }> = {
  open: { text: 'live', color: palette.green },
  connecting: { text: 'connecting…', color: palette.amber },
  closed: { text: 'offline', color: palette.textTertiary },
};

/** Small status dot + label reflecting the live-reload SSE connection. */
export function LiveIndicator({ status }: { status: LiveStatus }): React.JSX.Element {
  const { text, color } = LABELS[status];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: sp[3],
        marginTop: sp[5],
        fontSize: 10,
        color: palette.textTertiary,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
      }}
      title={`Live reload: ${text}`}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          boxShadow: status === 'open' ? `0 0 4px ${color}` : 'none',
        }}
      />
      {text}
    </div>
  );
}
