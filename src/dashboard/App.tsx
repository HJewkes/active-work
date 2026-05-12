import React, { useState } from 'react';
import { palette, radii, sp } from './tokens.js';
import { InitiativesView } from './views/Initiatives.js';
import { TasksView } from './views/Tasks.js';
import { ArtifactsView } from './views/Artifacts.js';

type ViewId = 'initiatives' | 'tasks' | 'artifacts';

interface NavItem {
  id: ViewId;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'initiatives', label: 'Initiatives' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'artifacts', label: 'Artifacts' },
];

export function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('initiatives');

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: palette.bg,
      }}
    >
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          background: palette.surface1,
          borderRight: `1px solid ${palette.border}`,
          padding: sp[10],
          display: 'flex',
          flexDirection: 'column',
          gap: sp[12],
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: palette.brand,
              textTransform: 'uppercase',
              letterSpacing: 0.8,
            }}
          >
            active-work
          </div>
          <div
            style={{
              fontSize: 11,
              color: palette.textTertiary,
              marginTop: 2,
            }}
          >
            read-only dashboard
          </div>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: sp[2] }}>
          {NAV_ITEMS.map((item) => {
            const active = view === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                style={{
                  appearance: 'none',
                  textAlign: 'left',
                  background: active ? `${palette.brand}1a` : 'transparent',
                  border: `1px solid ${active ? `${palette.brand}55` : 'transparent'}`,
                  color: active ? palette.brand : palette.textSecondary,
                  padding: `${sp[5]}px ${sp[6]}px`,
                  borderRadius: radii.sm,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <main
        style={{
          flex: 1,
          padding: sp[12],
          overflowY: 'auto',
        }}
      >
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          {view === 'initiatives' && <InitiativesView />}
          {view === 'tasks' && <TasksView />}
          {view === 'artifacts' && <ArtifactsView />}
        </div>
      </main>
    </div>
  );
}
