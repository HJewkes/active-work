import React, { useEffect, useState } from 'react';
import { palette, sp, typography } from '../tokens.js';
import { TaskRow } from '../components/TaskRow.js';
import { fetchTasks } from '../utils/api.js';
import type { TasksResult } from '../types.js';

export function TasksView(): React.JSX.Element {
  const [data, setData] = useState<TasksResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTasks()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) {
    return (
      <div
        style={{
          background: `${palette.red}11`,
          border: `1px solid ${palette.red}55`,
          color: palette.red,
          padding: sp[8],
          borderRadius: 8,
          fontSize: 13,
        }}
      >
        Error: {err}
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ color: palette.textTertiary, fontSize: 13 }}>Loading…</div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: sp[8] }}>
      <h1 style={{ margin: 0, fontSize: 22, color: palette.textPrimary }}>
        Open tasks
      </h1>
      <p
        style={{
          margin: 0,
          fontSize: 12,
          color: palette.textTertiary,
        }}
      >
        {data.tasks.length} open task(s) across all initiatives, sorted by
        priority.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            '100px 110px 1fr 110px 70px 90px minmax(120px, 1fr)',
          gap: sp[6],
          padding: `${sp[4]}px ${sp[8]}px`,
          fontSize: 11,
          color: palette.textTertiary,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontFamily: typography.body,
        }}
      >
        <span>Slug</span>
        <span>ID</span>
        <span>Title</span>
        <span>Severity</span>
        <span>Priority</span>
        <span>Estimate</span>
        <span>Tags</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp[3] }}>
        {data.tasks.map((task) => (
          <TaskRow key={`${task.slug}/${task.id}`} task={task} />
        ))}
        {data.tasks.length === 0 && (
          <p style={{ margin: 0, color: palette.textTertiary, fontSize: 13 }}>
            No open tasks. Inbox zero, nice.
          </p>
        )}
      </div>
    </div>
  );
}
