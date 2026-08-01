import React, { useEffect } from 'react';
import { palette, radii, sp, typography } from '../tokens.js';

interface Props {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  /** Auto-dismiss after this many ms, default 5000. */
  durationMs?: number;
}

/** Bottom-of-viewport toast with a single undo-style action. */
export function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = 5000,
}: Props): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [onDismiss, durationMs]);

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: sp[16],
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: sp[8],
        padding: `${sp[6]}px ${sp[8]}px`,
        borderRadius: radii.md,
        background: palette.surface3,
        border: `1px solid ${palette.borderStrong}`,
        color: palette.textPrimary,
        fontSize: 13,
        fontFamily: typography.body,
        boxShadow: '0 8px 22px rgba(0,0,0,0.5)',
        zIndex: 100,
      }}
    >
      <span>{message}</span>
      <button
        onClick={onAction}
        style={{
          background: 'none',
          border: 'none',
          color: palette.brand,
          fontWeight: 600,
          fontSize: 13,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
