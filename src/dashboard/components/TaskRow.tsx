import React from 'react';
import { palette, sp, typography, severityColor } from '../tokens.js';
import { StateBadge } from './StateBadge.js';
import type { TaskItem } from '../types.js';

interface Props {
  task: TaskItem;
}

/** Read-only row primitive for one task in the cross-initiative table. */
export function TaskRow({ task }: Props): React.JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns:
          '100px 110px 1fr 110px 70px 90px minmax(120px, 1fr)',
        alignItems: 'center',
        gap: sp[6],
        padding: `${sp[6]}px ${sp[8]}px`,
        background: palette.surface1,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      <span
        style={{
          fontFamily: typography.mono,
          fontSize: 11,
          color: palette.textTertiary,
        }}
      >
        {task.slug}
      </span>
      <span
        style={{
          fontFamily: typography.mono,
          fontSize: 12,
          color: palette.brand,
        }}
      >
        {task.id}
      </span>
      <span style={{ color: palette.textPrimary }}>{task.title}</span>
      <span>
        {task.severity ? (
          <StateBadge
            label={task.severity}
            color={severityColor[task.severity]}
          />
        ) : (
          <span style={{ color: palette.textTertiary }}>—</span>
        )}
      </span>
      <span
        style={{
          fontFamily: typography.mono,
          color: palette.textSecondary,
        }}
      >
        p{task.priority}
      </span>
      <span
        style={{
          fontFamily: typography.mono,
          color: palette.textSecondary,
        }}
      >
        {task.estimate ?? '—'}
      </span>
      <span
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: sp[2],
        }}
      >
        {(task.tags ?? []).map((tag) => (
          <span
            key={tag}
            style={{
              fontSize: 11,
              padding: `${sp[1]}px ${sp[4]}px`,
              borderRadius: 4,
              background: palette.surface3,
              color: palette.textSecondary,
            }}
          >
            {tag}
          </span>
        ))}
      </span>
    </div>
  );
}
