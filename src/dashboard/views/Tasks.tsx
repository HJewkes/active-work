import React, { useEffect, useMemo, useState } from 'react';
import { palette, sp, typography, severityColor } from '../tokens.js';
import { Card } from '../components/shared/Card.js';
import { DataTable, type DataTableColumn } from '../components/shared/DataTable.js';
import { StateBadge } from '../components/StateBadge.js';
import { Toast } from '../components/Toast.js';
import { fetchTasks, markTaskDone, reorderTask, undoTaskDone } from '../utils/api.js';
import type { TaskItem, ViewProps } from '../types.js';

interface PendingUndo {
  task: TaskItem;
}

const COLUMNS: DataTableColumn[] = [
  { key: 'id', label: 'ID', width: 90 },
  { key: 'title', label: 'Title', flex: 1 },
  { key: 'severity', label: 'Severity', width: 100 },
  { key: 'priority', label: 'Priority', width: 70 },
  { key: 'estimate', label: 'Estimate', width: 70 },
  { key: 'tags', label: 'Tags', width: 160 },
  { key: 'actions', label: '', width: 70 },
];

/** Groups tasks by initiative, preserving each group's first-seen (priority) order. */
function groupBySlug(tasks: TaskItem[]): Array<{ slug: string; tasks: TaskItem[] }> {
  const order: string[] = [];
  const bySlug = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    if (!bySlug.has(task.slug)) {
      order.push(task.slug);
      bySlug.set(task.slug, []);
    }
    bySlug.get(task.slug)!.push(task);
  }
  return order.map((slug) => ({ slug, tasks: bySlug.get(slug)! }));
}

export function TasksView({ refreshToken }: ViewProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTasks()
      .then((d) => {
        if (!cancelled) setTasks(d.tasks);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const sections = useMemo(() => groupBySlug(tasks ?? []), [tasks]);

  function handleMarkDone(task: TaskItem): void {
    setTasks((prev) => (prev ?? []).filter((t) => !(t.slug === task.slug && t.id === task.id)));
    setPendingUndo({ task });
    markTaskDone(task.slug, task.id).catch((e: Error) => setErr(e.message));
  }

  function handleUndo(): void {
    if (!pendingUndo) return;
    const { task } = pendingUndo;
    setPendingUndo(null);
    undoTaskDone(task.slug, task.id)
      .then(() => setTasks((prev) => [...(prev ?? []), task]))
      .catch((e: Error) => setErr(e.message));
  }

  function handleDrop(sectionTasks: TaskItem[], target: TaskItem): void {
    const dragged = sectionTasks.find((t) => t.id === draggedId);
    setDraggedId(null);
    if (!dragged || dragged.id === target.id) return;

    setTasks((prev) => {
      if (!prev) return prev;
      const withoutDragged = prev.filter((t) => !(t.slug === dragged.slug && t.id === dragged.id));
      const targetIndex = withoutDragged.findIndex(
        (t) => t.slug === target.slug && t.id === target.id,
      );
      const next = [...withoutDragged];
      next.splice(targetIndex, 0, dragged);
      return next;
    });

    reorderTask(dragged.slug, dragged.id, target.priority).catch((e: Error) => setErr(e.message));
  }

  function renderCell(task: TaskItem, columnKey: string): React.ReactNode {
    switch (columnKey) {
      case 'id':
        return (
          <span style={{ fontFamily: typography.mono, fontSize: 12, color: palette.brand }}>
            {task.id}
          </span>
        );
      case 'title':
        return <span style={{ color: palette.textPrimary, fontSize: 13 }}>{task.title}</span>;
      case 'severity':
        return task.severity ? (
          <StateBadge label={task.severity} color={severityColor[task.severity]} />
        ) : (
          <span style={{ color: palette.textTertiary }}>—</span>
        );
      case 'priority':
        return (
          <span style={{ fontFamily: typography.mono, color: palette.textSecondary, fontSize: 13 }}>
            p{task.priority}
          </span>
        );
      case 'estimate':
        return (
          <span style={{ fontFamily: typography.mono, color: palette.textSecondary, fontSize: 13 }}>
            {task.estimate ?? '—'}
          </span>
        );
      case 'tags':
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: sp[2] }}>
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
          </div>
        );
      case 'actions':
        return (
          <button
            onClick={() => handleMarkDone(task)}
            style={{
              background: 'none',
              border: `1px solid ${palette.borderStrong}`,
              borderRadius: 4,
              color: palette.textSecondary,
              fontSize: 11,
              padding: `${sp[1]}px ${sp[4]}px`,
              cursor: 'pointer',
            }}
          >
            Done
          </button>
        );
      default:
        return null;
    }
  }

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
  if (!tasks) {
    return <div style={{ color: palette.textTertiary, fontSize: 13 }}>Loading…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: sp[10] }}>
      <h1 style={{ margin: 0, fontSize: 22, color: palette.textPrimary }}>Open tasks</h1>
      <p style={{ margin: 0, fontSize: 12, color: palette.textTertiary }}>
        {tasks.length} open task(s) across {sections.length} initiative(s). Drag a row to
        reorder within its initiative; use Done to complete a task.
      </p>
      {sections.map(({ slug, tasks: sectionTasks }) => (
        <div key={slug} style={{ display: 'flex', flexDirection: 'column', gap: sp[4] }}>
          <h2
            style={{
              margin: 0,
              fontSize: 13,
              fontFamily: typography.mono,
              color: palette.textSecondary,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            {slug}
          </h2>
          <Card variant="plain" padding={sp[4]}>
            <DataTable
              columns={COLUMNS}
              data={sectionTasks}
              getKey={(task) => task.id}
              renderCell={renderCell}
              renderRow={(task, cells) => (
                <div
                  key={task.id}
                  draggable
                  onDragStart={() => setDraggedId(task.id)}
                  onDragEnd={() => setDraggedId(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(sectionTasks, task);
                  }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '90px 1fr 100px 70px 70px 160px 70px',
                    alignItems: 'center',
                    gap: sp[6],
                    padding: `${sp[5]}px ${sp[6]}px`,
                    borderRadius: 6,
                    cursor: 'grab',
                    opacity: draggedId === task.id ? 0.4 : 1,
                    background: palette.surface1,
                  }}
                >
                  {cells}
                </div>
              )}
            />
          </Card>
        </div>
      ))}
      {sections.length === 0 && (
        <p style={{ margin: 0, color: palette.textTertiary, fontSize: 13 }}>
          No open tasks. Inbox zero, nice.
        </p>
      )}
      {pendingUndo && (
        <Toast
          message={`Marked ${pendingUndo.task.id} done`}
          actionLabel="Undo"
          onAction={handleUndo}
          onDismiss={() => setPendingUndo(null)}
        />
      )}
    </div>
  );
}
