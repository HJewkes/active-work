# tools/ — session-log miners

Deterministic, dependency-free Node ESM scripts that read Claude Code session
transcripts (`~/.claude/projects/<encoded-cwd>/*.jsonl`) and derive typed,
navigable engineering history. Same transcripts in → same output out; they
stream line-by-line so a multi-hundred-MB corpus mines quickly.

These are the sourcing layer for the cost / eval / error-atlas work
(AW-24, AW-27, AW-28). They intentionally have **no runtime deps** — only
`node:` builtins — so they never touch the package's dependency graph or the
`postinstall` path.

## Scripts

| Script | Reads | Emits | Purpose |
|---|---|---|---|
| `mine-session-signals.mjs` | transcripts for one repo | typed TS module | Full signal surface: PRs, branches, commits/pushes, files, tasks, subagents, per-session metrics (per-model token buckets incl. cache-creation, thinking, errors, turn durations, mode/permission phases, human edits) — every asset back-referencing the sessions/turns that touched it. |
| `mine-file-history.mjs` | transcripts for one project dir | typed TS module | Per-file activity from recorded tool calls: reads/writes/edits, net growth, co-change edges, recency timeline. |
| `export-aw-data.mjs` | `active-work` CLI + initiative prose | typed TS module | Snapshot real active-work state (structured data + brief/handoff/session bodies) into a fixture for read-only dashboard specimens. |

## Usage

```bash
# Full session-signal extraction, scoped to one repo (worktree-aware)
node tools/mine-session-signals.mjs --repo /abs/path/to/repo [--top N] [--out file.ts]

# Per-file history for one ~/.claude/projects/<encoded-cwd> dir
node tools/mine-file-history.mjs <encoded-project-dir> [--top N] [--out file.ts]

# Snapshot active-work state for the dashboard specimens
node tools/export-aw-data.mjs [focus-slug]
```

Convenience wrappers are wired in `package.json` (`pnpm mine:session`,
`pnpm mine:files`, `pnpm export:aw-data`).

`--out` defaults to `../data/<name>.ts` (relative to this dir). Point it at
whatever consumes the fixture — e.g. the dashboard specimens' data directory.
Generated output under `tools/out/` and `data/` is git-ignored.

## Status

Ported verbatim from the `titan-design` lab branch where they were prototyped.
The longer-term plan (AW-28) is a native TypeScript port into `src/` wired into
the discover pipeline; until then they live here as standalone `.mjs` tools,
outside the linted `src`/`__tests__` surface.
