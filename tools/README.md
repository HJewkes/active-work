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
| `cost-rollup.mjs` | a `mine-session-signals` output + `pricing/models.json` | typed TS module | Price per-model token buckets (in / out / cacheRead / cacheCreation) and roll spend up to each session, PR, and the whole initiative. |
| `eval-miner.mjs` | the live corpus + `gh`/`git` ground truth | scorecard (stdout/JSON) | Score the miner: ground-truth precision/coverage for PRs/branches/files, determinism (frozen-input hash), performance ceiling. Non-zero exit on gate failure. |

## Pricing

`cost-rollup.mjs` reads a **separate, versioned** pricing table at
`pricing/models.json` — token buckets are never priced at ingest, so re-pricing
history is a table edit, not a re-mine. Rates are per-million-tokens; cache reads
bill at 0.1× input and 5-minute cache writes at 1.25× input. Raw model ids are
normalized (context `[1m]`, `-fast`, and trailing `-YYYYMMDD` suffixes stripped)
before lookup; any unmatched model is surfaced in the report, never silently
priced at zero.

## Usage

```bash
# Full session-signal extraction, scoped to one repo (worktree-aware)
node tools/mine-session-signals.mjs --repo /abs/path/to/repo [--top N] [--out file.ts]

# Per-file history for one ~/.claude/projects/<encoded-cwd> dir
node tools/mine-file-history.mjs <encoded-project-dir> [--top N] [--out file.ts]

# Snapshot active-work state for the dashboard specimens
node tools/export-aw-data.mjs [focus-slug]

# Price a mined signals file → per-session / per-PR / per-initiative cost
node tools/cost-rollup.mjs --signals <session-signals.ts|.json> [--pricing pricing/models.json] [--out file.ts] [--json]
node tools/cost-rollup.mjs --repo /abs/path/to/repo   # mines first, then prices

# Score the miner against gh/git ground truth (exit non-zero on gate failure)
node tools/eval-miner.mjs --repo /abs/path/to/repo [--min-precision 0.9] [--max-ms 30000] [--json]
```

## Eval (`eval-miner.mjs`)

Gates trusting everything built on the miner. Five checks:

1. **Ground-truth precision/coverage** vs `gh pr list` and `git` — PRs, branches,
   files. *precision* = are the miner's claims real; *coverage* = how much of the
   truth it surfaced (session-scoped, so coverage is informational).
2. **Determinism** — mines a **frozen snapshot** of the transcripts twice and
   requires an identical hash. (Mining the *live* corpus twice fails spuriously,
   because your own in-flight session transcript grows between runs.)
3. **Performance** — full mine under a ceiling (default 30 s).
4. **Coverage %** — summarized from check 1.
5. **LLM-item accuracy** — skipped until a downstream LLM field exists (AW-30).

**Hard gates** (non-zero exit): determinism, performance, PR-precision,
file-precision. **Branch-precision is reported, not gated** — worktree/cross-repo
branches the miner correctly attributes aren't in this repo's git, so its
"misses" mix real junk with legitimate cross-repo attribution; the offending
names are printed so a real regression is still visible.

The full run is a **local** pre-merge gate — it needs your `~/.claude`
transcripts, real git history, and `gh` auth, none of which exist in CI. CI runs
`pnpm check:tools` (syntax + pricing-table validity) and unit-tests the pure
scoring math (`__tests__/tools/eval-miner.test.ts`).

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
