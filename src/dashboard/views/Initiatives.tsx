import React, { useEffect, useState } from 'react';
import { palette, sp } from '../tokens.js';
import { InitiativeCard } from '../components/InitiativeCard.js';
import { fetchInitiatives } from '../utils/api.js';
import type { InitiativesResult, ViewProps } from '../types.js';

export function InitiativesView({ refreshToken }: ViewProps): React.JSX.Element {
  const [data, setData] = useState<InitiativesResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInitiatives()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (err) return <ErrorBlock message={err} />;
  if (!data) return <LoadingBlock />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: sp[12] }}>
      <h1 style={{ margin: 0, fontSize: 22, color: palette.textPrimary }}>
        Initiatives
      </h1>
      {data.sections.map((section) => (
        <section
          key={section.heading}
          style={{ display: 'flex', flexDirection: 'column', gap: sp[6] }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 600,
              color: palette.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
            }}
          >
            {section.heading} ({section.items.length})
          </h2>
          {section.items.length === 0 ? (
            <p style={{ margin: 0, color: palette.textTertiary, fontSize: 13 }}>
              No initiatives in this state.
            </p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                gap: sp[6],
              }}
            >
              {section.items.map((item) => (
                <InitiativeCard key={item.slug} item={item} />
              ))}
            </div>
          )}
        </section>
      ))}
      {data.parse_errors.length > 0 && (
        <section
          style={{
            border: `1px solid ${palette.red}55`,
            background: `${palette.red}11`,
            borderRadius: 8,
            padding: sp[8],
          }}
        >
          <h2 style={{ margin: 0, fontSize: 13, color: palette.red }}>
            Parse errors ({data.parse_errors.length})
          </h2>
          <ul
            style={{
              margin: `${sp[5]}px 0 0`,
              paddingLeft: sp[12],
              color: palette.textSecondary,
              fontSize: 12,
            }}
          >
            {data.parse_errors.map((e) => (
              <li key={e.slug}>
                <code>{e.slug}</code>: {e.error}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function LoadingBlock(): React.JSX.Element {
  return (
    <div style={{ color: palette.textTertiary, fontSize: 13 }}>Loading…</div>
  );
}

function ErrorBlock({ message }: { message: string }): React.JSX.Element {
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
      Error: {message}
    </div>
  );
}
