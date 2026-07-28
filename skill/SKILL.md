---
name: active-work
description: |
  Maintain durable per-initiative workspace state (brief, tasks, sessions, notes, artifacts) so engineering work picks up cleanly across Claude Code sessions. Use when the user mentions: "active work", "what am I working on", "bootstrap session", "new initiative", "record this session", "update handoff", "archive initiative", "check active", "audit my workstreams", "find untracked work", "set up active-work", "add a task", "mark X done", "what's blocking me", "wrap up", "I'm done", or types /active-work.
---

# active-work — durable workspace state across Claude sessions

`active-work` keeps a small filesystem-backed record for every engineering initiative the user has in flight. Files live under the active root (`~/Library/Application Support/active-work/<slug>/` on macOS — resolved via `env-paths`, which ignores `XDG_DATA_HOME`) and include `brief.md` (frontmatter + prose), `tasks/*.yml`, `sessions/*.md`, `artifacts.yml`, and `sources/` (including `sources/notes/` for durable notes). There is no `handoff.md`: current state is *derived* from the open-loop ledger in the session files, so it cannot go stale. The CLI is `active-work`; `aw <slug>` is a thin launcher that bootstraps a Claude session for an initiative. A long-running daemon, `active-work mcp serve`, exposes MCP tools to Claude Code over HTTP and serves a read-only dashboard at `http://127.0.0.1:7400/ui`.

## When to engage

Engage whenever the user signals they want to inspect, mutate, or hand off persistent workspace state. Trigger phrases:

- "active work" / "what am I working on" — list initiatives, surface current focus
- "bootstrap session" / `/active-work` — load the bootstrap prompt for an initiative
- "new initiative" — scaffold a slug with `active-work new`
- "add a task" / "mark X done" / "what's blocking me" — task ops via `active-work task`
- "record this session" / "update handoff" / "wrap up" / "I'm done" — session capture via `active-work wrap` (there is no handoff file; the phrase still means wrap)
- "archive initiative" — move a slug to the archived state
- "check active" / "audit my workstreams" — `active-work audit` health check
- "find untracked work" — `active-work discover` across configured sources
- "set up active-work" — first-time install / `active-work setup`

## Core rules

1. **Edits route through the CLI.** Use `active-work new`, `active-work set`, `active-work task add`, `active-work task done`, `active-work artifact add`, etc. Direct `Edit`/`Write` on `tasks/*.yml`, `artifacts.yml`, or the frontmatter of `brief.md` bypasses validation and corrupts the schema. Prose bodies (`brief.md` body, session summaries, note bodies) can be edited directly, but prefer `active-work edit` for `brief.md` because it re-validates frontmatter on save.
2. **LLM writes prose; CLI handles structure.** Task ordering, session filenames, frontmatter dates, slug normalization, and rank reflow are CLI primitives. Don't compute them yourself.
3. **`active-work --help` is the canonical command reference.** This skill intentionally doesn't duplicate the surface; run `active-work --help` or `active-work <command> --help` when you need flags.
4. **Wrap is the end of the world.** See "Wrapping a session" below. This is the rule agents most often get wrong, and getting it wrong loses the user's work.
5. **`active-work mcp status` first.** If MCP tools aren't responding, the daemon may not be running. Start it with `active-work mcp serve --detach` before retrying.

## Wrapping a session

**Assume the process exits the instant `wrap` returns, and that everything not written to disk is lost.** Not summarized in chat — *written*. The user will very likely start a fresh session immediately; the only thing that survives is what is on disk. Chat scrollback does not carry over.

The failure this is designed to prevent: an agent posts its session summary, then follows it with two to four "oh, by the way" items — a task that should be filed, a gotcha worth remembering, an uncommitted worktree — each of which then has to be captured before the session can actually end. **Do that sweep before calling `wrap`, not after.** If you find yourself about to write "one more thing" after wrapping, you wrapped too early.

Run `active-work preflight <slug>` first. It is read-only and returns the live git state plus the checklist of categories you must answer.

Then sweep your own session for everything durable and file it:

| What you have | Where it goes |
|---|---|
| Unfinished work, open PRs, unanswered questions | `--next-steps` (the open-loop ledger) |
| Prior loops this session closed | `--resolves` with `outcome: done` |
| A thread you're deliberately dropping | `--resolves` with `outcome: abandoned` **and a note saying why** — the note is required, and it surfaces in the bootstrap for 14 days so nobody proposes the dropped thing again |
| Anything actionable | `active-work task add` before wrapping, then `--tasks-filed` |
| Process improvements, gotchas, "avoid this next time", non-actionable FYIs | `--notes` (lands in `sources/notes/`, indexed in every future bootstrap) |
| Uncommitted work, unpushed branches, stashes, worktree state | recorded automatically by `wrap`; add `holding` context if the bare fact isn't enough |

Every category needs an **explicit** answer. Omitting a flag is an error, not a shortcut — the assert-nothing forms (`--no-loops`, `--no-notes`, `--no-tasks`) exist so that "there was nothing here" is a claim you make deliberately rather than by forgetting. Use them only when they are actually true.

**active-work is the source of truth — not `~/.claude` memory, not `CLAUDE.md`.** A process lesson written to memory is invisible to the next session on this initiative and to every other surface. File it as a note.

Then report back plainly: the counts of what was filed and updated, and that you are ready to end. `wrap` returns exactly that receipt — relay it rather than re-deriving it.

Auto-prompt the wrap when you detect the user winding down ("I'm done", "let's stop", "wrap up", inactivity after a chunk of work).

## Bootstrap flow (`aw <slug>` / `active-work open <slug>`)

`aw <slug>` is the operator-facing launcher: it assembles the bootstrap prompt and execs `claude` with the initiative's worktree as cwd. Omit the slug and it resolves the initiative from the caller's cwd (matching against each brief's registered worktrees), falling back to the interactive picker when nothing matches uniquely; `aw --pick` forces the picker. (Register a worktree so this resolution works with `active-work worktree set <slug> <path>`, or at creation via `new --worktree` / `track --worktree`.) `active-work open <slug>` is the same assembly logic, but prints the prompt to stdout instead of spawning Claude — use it from MCP / scripts / any caller that wants to handle the spawn itself (pass `--cwd <dir>` when the caller's process cwd isn't the user's shell cwd, e.g. the daemon). The bootstrap prompt inlines:

- A brief excerpt (the brief's prose body, truncated to 40 lines)
- **Open loops** — unresolved `next_steps` from prior sessions, with the age of each hang
- **Abandoned loops** from the last 14 days, each with the reason it was dropped (`active-work loops <slug> --state abandoned` for the full history)
- The most recent session summary
- The top N open tasks (rank-sorted)
- Recently-done tasks from the last 14 days, if any
- **Durable notes** — newest first, capped by count and never expired by age
- Open artifacts with status
- A context block with today's date, bootstrap time, and time since the last session

To re-seed context **mid-session** (a session that wasn't started via `aw`, or one that has drifted), run `active-work prompt` — it prints the same bootstrap prompt to stdout, cwd-resolved and side-effect-free (no auto-archive). The bundled `/aw-prompt` slash command wraps it and injects the output straight into the session.

The brief excerpt is already in your context, so **do not re-read `brief.md`** at the top of the session. Current state needs no separate file — it is the open-loop section, derived fresh at every bootstrap from the session ledger. Jump straight to the highest-rank open task unless the user redirects you. If the user opens a slug without further instruction, ask "continue with `<top task title>`?" and proceed on confirmation.

**Ad-hoc sessions** (`aw <slug> --adhoc`, also `open`/`prompt --adhoc`): the opening and closing directives change to say the session is scoped to ad-hoc work on the workstream — the context is background, *not* a directive. Do **not** offer to continue the top task; wait for the user to describe the specific ad-hoc task, then work it with the workstream context in mind. The bootstrap prompt itself carries this instruction, so follow whichever framing it renders.

## Reference docs

- [onboarding.md](references/onboarding.md) — first-time setup walkthrough
- [auditing-existing-work.md](references/auditing-existing-work.md) — discover + triage flow for catching up on untracked work
- [cli-dev.md](references/cli-dev.md) — internal architecture for skill maintainers and CLI contributors
