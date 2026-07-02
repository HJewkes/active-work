import React, { useEffect, useMemo, useState } from 'react';
import { palette, radii, sp, typography } from '../tokens.js';
import { fetchArtifacts } from '../utils/api.js';
import type {
  ArtifactsResult,
  BranchEntry,
  StashEntry,
  ViewProps,
} from '../types.js';

interface BranchRow extends BranchEntry {
  slug: string;
}
interface StashRow extends StashEntry {
  slug: string;
}

export function ArtifactsView({ refreshToken }: ViewProps): React.JSX.Element {
  const [data, setData] = useState<ArtifactsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchArtifacts()
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

  const flattened = useMemo(() => {
    if (!data) return { branches: [], stashes: [] };
    const branches: BranchRow[] = [];
    const stashes: StashRow[] = [];
    for (const item of data.items) {
      for (const br of item.artifacts.branches) {
        branches.push({ ...br, slug: item.slug });
      }
      for (const st of item.artifacts.stashes) {
        stashes.push({ ...st, slug: item.slug });
      }
    }
    branches.sort((a, b) => a.name.localeCompare(b.name));
    return { branches, stashes };
  }, [data]);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: sp[12] }}>
      <h1 style={{ margin: 0, fontSize: 22, color: palette.textPrimary }}>
        Artifacts
      </h1>

      <Section title={`Tracked Branches (${flattened.branches.length})`}>
        {flattened.branches.length === 0 ? (
          <Empty text="No tracked branches." />
        ) : (
          flattened.branches.map((br) => (
            <Row key={`${br.slug}/${br.repo}/${br.name}`}>
              <Mono color={palette.textTertiary}>{br.slug}</Mono>
              <Mono color={palette.teal}>
                {br.repo}/{br.name}
              </Mono>
              <span style={{ color: palette.textPrimary }}>{br.note ?? ''}</span>
            </Row>
          ))
        )}
      </Section>

      <Section title={`Stashes (${flattened.stashes.length})`}>
        {flattened.stashes.length === 0 ? (
          <Empty text="No stashes tracked." />
        ) : (
          flattened.stashes.map((st, i) => (
            <Row key={`${st.slug}/${st.repo}/${i}`}>
              <Mono color={palette.textTertiary}>{st.slug}</Mono>
              <Mono color={palette.amber}>{st.repo}</Mono>
              <span style={{ color: palette.textPrimary }}>{st.label}</span>
            </Row>
          ))
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: sp[6] }}>
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
        {title}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp[3] }}>
        {children}
      </div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 240px 1fr',
        alignItems: 'center',
        gap: sp[6],
        padding: `${sp[6]}px ${sp[8]}px`,
        background: palette.surface1,
        border: `1px solid ${palette.border}`,
        borderRadius: radii.sm,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function Mono({
  color,
  children,
}: {
  color: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span style={{ fontFamily: typography.mono, fontSize: 12, color }}>
      {children}
    </span>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return (
    <p style={{ margin: 0, color: palette.textTertiary, fontSize: 13 }}>
      {text}
    </p>
  );
}
