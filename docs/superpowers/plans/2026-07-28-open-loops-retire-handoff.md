# Open loops: derive state from sessions, retire `handoff.md`

Status: proposed (2026-07-28)
Author: ad-hoc session on `active-work`

## Problem

Sessions end without the handoff being updated, and handoffs go stale. The audit
below shows the cause is not operator discipline — it is that `handoff.md` has no
writer, no reader, and no timestamp.

### Findings

**1. There is no non-interactive write path.** `handoff.md` is written at creation
only (`src/commands/new.ts:121`, `src/commands/track.ts:101`). The sole updater is
`active-work edit --target handoff` (`src/commands/edit.ts:99`), which shells out
to `$EDITOR` — unusable by Claude. There is no `handoff set`. Every update in the
live data was made by hand or by a raw `Write` that bypasses validation.

**2. The wrap-up checklist never mentions it.** `skill/SKILL.md:30` defines wrap-up
as `active-work session record <slug>` and nothing else. `session-record.ts` writes
`sessions/<stamp>.md` and returns — it does not touch `handoff.md` or even bump
`brief.updated`.

**3. Nothing reads it.** `src/bootstrap/prompt.ts` never opens `handoff.md`; the
sections it assembles are brief excerpt, last session, tasks, artifacts, context
(lines 626–671). But `skill/SKILL.md:37` advertises "The full `handoff.md` text" as
the first bootstrap section, and `:46` instructs Claude **not to re-read it** because
it is supposedly already in context. It is not. The file has no consumer, and the
agent is explicitly told not to look at it — so it can be arbitrarily stale with no
observable effect until a human opens it.

**4. Staleness is unmeasurable.** `handoff.md` has no frontmatter and no timestamp.
The only probe is mtime, which migrations corrupt: `home-assistant/sessions/*.md`
show mtime 2026-07-13 but `ended: 2026-05-12`. `src/lint/handoff.ts` checks exactly
one thing — body line count. `audit` and `doctor` check nothing.

### What the handoffs contain

3,389 lines across 17 files:

| Bucket | Weight | Existing home |
|---|---|---|
| HISTORY | dominant (~1,800 of codewatch's 2,198; 15–40% of the busy four) | `sessions/` — the stronger record wherever both exist |
| DECISIONS + rationale | ~120 lines (dormant set), ~300–400 (codewatch) | `brief.md` — already near-verbatim in relay, brain, taxes |
| OPERATIONAL | ~98 lines | `sources/` — nothing routes it there |
| REFERENCE | ~30–50 lines | `sources/` |
| **CURRENT_STATE** | ~96 lines (dormant), 20–40% of busy four | **none** |
| **NEXT_ACTIONS not filed as tasks** | ~93 lines | **none** |

Two buckets have no home. Everything else is duplication or misfiling.

### Convergent evidence

Operators independently hand-rolled the missing primitive twice:

- `codewatch/handoff.md` invented `## TOP OF STACK`, `## NEXT SESSION PLAN`,
  `## Follow-ups surfaced (not yet done)` headings, appended reverse-chronologically.
  Two blocks (lines 686, 760) are labeled "superseded by the block above" and still
  carry their full bodies.
- `voltras-workspace` invented `coordination/NEXT-SESSION-2026-07-27.md`.

Both were ignored or went stale, because nothing reads them.

`voltras-workspace/handoff.md:227-243` is the operator's own postmortem of a drift
incident:

> 1. **`handoff.md` was 12 days stale** and `brief.md`'s "in-flight efforts" was 22
>    days stale […]
> 2. **The session-bootstrap task list is ordered by `priority`,** and VW-68 sat at p1
>    […] "Work the top task" then points at the wrong thing with full confidence.
> 3. **`coordination/NEXT-SESSION-2026-07-27.md` — literally titled "start here" — was
>    never opened.**
>
> Two of the four things the user actually cared about […] **had no VW-level task at
> all, so they could not appear in a priority list however it was sorted.**

That last sentence is the load-bearing one: re-ranking cannot fix it. Work never
filed as a task is structurally unreachable by the bootstrap.

### Lineage gaps (independent, mechanical)

- `track: 'canonical' | 'sidecar'` exists (`src/schemas/session.ts:22`) but is used
  only as a filter (`prompt.ts:177`); only `fold.ts:85` writes `sidecar`.
  `session record` **defaults to canonical** (`session-record.ts:16`), so an ad-hoc
  session's summary becomes `# Last session` for the next mainline bootstrap.
- Bootstrap renders exactly one session — `sessions[0]` sorted by `ended` desc
  (`prompt.ts:186`, `:638`). A long mainline session that started before and ended
  after a short ad-hoc one sorts behind it.
- Session frontmatter has no linkage fields. Two sessions run in parallel on
  different worktrees are indistinguishable from two run back-to-back.
- `compareTasksByPriority` (`prompt.ts:260`) is static priority + id tiebreak. No
  recency, no follow-up linkage.

## Design: open loops

**State is derived, never stored.** A separate "current state" file would just
reintroduce the artifact that goes stale. Instead, each session records the loops it
*opens* and the loops it *closes*; live state is the unresolved remainder, computed
at bootstrap. Staleness becomes unrepresentable — there is no denormalized copy to lag.

### Session schema additions

Both fields optional, defaulting to `[]`, so existing sessions stay valid.

```yaml
session_id: 731ae3d3-...
started: '2026-07-16T...'
ended: '2026-07-16T...'
track: canonical | sidecar | adhoc
next_steps:
  - id: n1                    # unique within session; global ref = <session_id>#n1
    text: 'Wire cost rollup into the daemon'
    kind: task | pr | prose
    ref: AW-24                # task id, PR number, or omitted for prose
resolves:
  - ref: 8f2c1a44#n3          # a prior session's next_step
    outcome: done | abandoned
    note: 'superseded by the SQLite index'   # required when abandoned
```

### Derivation

`openLoops(initiative)` = every `next_step` across all sessions, minus:

- any with a matching `resolves` entry in any later session, and
- **auto-resolved** loops: `kind: task` whose task is `status: done`; `kind: pr`
  whose artifact is merged. This is the payoff for typing them.

Each surviving loop carries `age = now − originating session.ended`. One session may
resolve loops from many prior sessions — that edge is the lineage record, and it is
what lets ad-hoc and parallel sessions reconcile without a shared mutable file.

**Loop derivation ignores `track`.** Ad-hoc work opens real loops. `track` selects
which session is the *narrative* "last mainline session"; it must not gate the ledger.

### Bootstrap rendering

Replace the single `# Last session` block with:

```
# Open loops (3 hanging, oldest 21d)
- [21d] AW-23 SQLite index — blocked on eval harness   (from 2026-07-07, sess 8f2c…)
- [12d] Miner cost rollups need daemon wiring          (from 2026-07-16, sess 731e…)
- [ 2d] PR #57 awaiting review                         (from 2026-07-26, sess a91b…)

# Last mainline session (2026-07-16) — 12 days ago
…narrative excerpt…
```

Only sessions with hanging work appear. Age is explicit, so a months-old thread stays
visible and the agent can judge whether to work it or resolve it as `abandoned`.

Age bands drive prompting: `<3d` fresh · `3–14d` aging · `14–60d` stale, prompt to
re-rank or abandon · `>60d` abandonment candidate, prompt explicitly.

The priority task list stays, demoted below open loops.

### `active-work wrap <slug>`

One atomic, `withFileLock`-guarded operation replacing the multi-step checklist:
session record + `next_steps` + `resolves` + `brief.updated` touch. A half-finished
wrap-up becomes impossible rather than merely discouraged. `session record` remains
for narrative-only writes.

### Lint / doctor

- warn: open loop older than N days (default 30)
- warn: a wrap recorded zero `next_steps` **and** zero `resolves` — usually means the
  agent skipped the thinking
- doctor: dangling `resolves.ref` pointing at a nonexistent next_step
- doctor: empty initiative scaffolds (see cleanup below)
- delete `src/lint/handoff.ts`

## Migration (v2 → v3)

Assisted, per-initiative. `.schema-version` on disk is currently `1`;
`CURRENT_VERSION` is `2`, so the v1→v2 artifacts migration is still pending — sequence
this after it.

Mechanical part (`src/migrations/v2-to-v3-open-loops.ts`, idempotent per the
`Migration` contract):

1. Add `next_steps` / `resolves` to `SessionFrontmatterSchema`, defaulting to `[]`.
2. Copy each `handoff.md` to `sources/handoff-archive.md` as a safety net.
3. Remove `handoff.md` from `new.ts`, `track.ts`, `edit.ts`, `paths.ts`, lint.

Assisted part, one initiative at a time, Claude reviewing each:

4. Split the archived handoff by bucket: DECISIONS → `brief.md`; OPERATIONAL and
   REFERENCE → purpose-named files in `sources/`; HISTORY → **dropped** where
   `sessions/` already covers it (verified for codewatch: 58 session files back to
   2026-05-12 vs the handoff's oldest block at 2026-06-30).
5. CURRENT_STATE and NEXT_ACTIONS → a synthetic migration session per initiative
   (`track: migration`) carrying them as `next_steps`, so they enter the ledger and
   start aging visibly.
6. Drop `sources/handoff-archive.md` once the split is reviewed.

### Migration hazards

- **`denver-rezzy`**: `tasks/` is empty. Its handoff is the sole record of all seven
  next-actions. Extract to tasks **before** anything else touches it.
- **`computer-organization`**: per-directory triage calls (delete vs archive) exist
  only in the handoff, in no `CO-*.yml`.
- **`herald`**: blocker cites a "claim SDK credit ~June 8 (June 15 billing change)"
  window, lapsed seven weeks. Migrate as an explicitly `abandoned` loop, not a live one.
- **`codewatch`**: 2,198 lines, ~1,800 HISTORY. Highest-volume drop; review carefully.

### Unrelated cleanup

`dbs-email-scope-reconstruction`, `titan-visual-gt-refresh-surface-ramp`,
`vmcp-logic-burndown` are completely empty scaffolds — no brief, tasks, sessions, or
sources. Delete them.

## Independent mechanical fixes

Correct regardless of the above; ship first:

- `--adhoc` sessions must not record as `track: canonical`.
- Bootstrap must render the last mainline session plus any ad-hoc/sidecar sessions
  since it, instead of `sessions[0]` alone.
- Sort sessions by `(ended, started)` so overlapping sessions order deterministically.
- Fix `skill/SKILL.md:37` and `:46`, which describe a bootstrap that does not exist.

## Risks

- **Derivation cost.** `voltras-workspace` has 106 sessions. Bootstrap would read all
  session frontmatter each launch. Files are small; measure before optimizing. The
  eventual home is the AW-23 SQLite index.
- **Concurrent resolution.** Two parallel sessions resolving the same loop: identical
  outcomes are idempotent, conflicting ones surface in `doctor`. Not blocking.
- **Agent compliance.** Loops are only as good as what the agent files at wrap. The
  zero-loops lint is the backstop.

## Open questions

- Threshold for the stale-loop warning — 30 days assumed.
- Should `abandoned` loops stay visible in a collapsed tail, or vanish? Assumed vanish,
  recoverable from the session file.
- Does `track: adhoc` warrant a third enum value, or is `sidecar` sufficient?
