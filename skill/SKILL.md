---
name: active-work
description: |
  Maintain durable per-initiative workspace state (brief, handoff, tasks, sessions, artifacts) so engineering work picks up cleanly across Claude Code sessions. Use when the user mentions: "active work", "what am I working on", "bootstrap session", "new initiative", "record this session", "update handoff", "archive initiative", "check active", "audit my workstreams", "find untracked work", "set up active-work", "add a task", "mark X done", "what's blocking me", "wrap up", "I'm done", or types /active-work.
---

# active-work — durable workspace state across Claude sessions

`active-work` keeps a small filesystem-backed record for every engineering initiative the user has in flight. Files live under `$XDG_DATA_HOME/active-work/<slug>/` and include `brief.md` (frontmatter + prose), `handoff.md` (free prose), `tasks/*.yml`, `sessions/*.md`, `artifacts.yml`, and `sources/`. The CLI is `active-work`; `aw <slug>` is a thin launcher that bootstraps a Claude session for an initiative. A long-running daemon, `active-work mcp serve`, exposes MCP tools to Claude Code over HTTP and serves a read-only dashboard at `http://127.0.0.1:7400/ui`.

## When to engage

Engage whenever the user signals they want to inspect, mutate, or hand off persistent workspace state. Trigger phrases:

- "active work" / "what am I working on" — list initiatives, surface current focus
- "bootstrap session" / `/active-work` — load the bootstrap prompt for an initiative
- "new initiative" — scaffold a slug with `active-work new`
- "add a task" / "mark X done" / "what's blocking me" — task ops via `active-work task`
- "record this session" / "update handoff" / "wrap up" / "I'm done" — session capture + handoff
- "archive initiative" — move a slug to the archived state
- "check active" / "audit my workstreams" — `active-work audit` health check
- "find untracked work" — `active-work discover` across configured sources
- "set up active-work" — first-time install / `active-work setup`

## Core rules

1. **Edits route through the CLI.** Use `active-work new`, `active-work set`, `active-work task add`, `active-work task done`, `active-work artifact add`, etc. Direct `Edit`/`Write` on `tasks/*.yml`, `artifacts.yml`, or the frontmatter of `brief.md` bypasses validation and corrupts the schema. Prose bodies (`brief.md` body, `handoff.md`, session summaries) can be edited directly, but prefer `active-work edit` for `brief.md` because it re-validates frontmatter on save.
2. **LLM writes prose; CLI handles structure.** Task ordering, session filenames, frontmatter dates, slug normalization, and rank reflow are CLI primitives. Don't compute them yourself.
3. **`active-work --help` is the canonical command reference.** This skill intentionally doesn't duplicate the surface; run `active-work --help` or `active-work <command> --help` when you need flags.
4. **Session capture at end.** When wrapping up, run `active-work session record <slug>` with a 3-5 bullet summary of what happened, what changed, and what's next. Auto-prompt this when you detect the user winding down ("I'm done", "let's stop", "wrap up", inactivity after a chunk of work).
5. **`active-work mcp status` first.** If MCP tools aren't responding, the daemon may not be running. Start it with `active-work mcp serve --detach` before retrying.

## Bootstrap flow (`aw <slug>` / `active-work open <slug>`)

`aw <slug>` is the operator-facing launcher: it assembles the bootstrap prompt and execs `claude` with the initiative's worktree as cwd. Omit the slug and it resolves the initiative from the caller's cwd (matching against each brief's registered worktrees), falling back to the interactive picker when nothing matches uniquely; `aw --pick` forces the picker. (Register a worktree so this resolution works with `active-work worktree set <slug> <path>`, or at creation via `new --worktree` / `track --worktree`.) `active-work open <slug>` is the same assembly logic, but prints the prompt to stdout instead of spawning Claude — use it from MCP / scripts / any caller that wants to handle the spawn itself (pass `--cwd <dir>` when the caller's process cwd isn't the user's shell cwd, e.g. the daemon). The bootstrap prompt inlines:

- The full `handoff.md` text
- A brief excerpt (frontmatter summary + first prose paragraph)
- The most recent session summary
- The top N open tasks (rank-sorted)
- Open artifacts with status
- Time since the last session

To re-seed context **mid-session** (a session that wasn't started via `aw`, or one that has drifted), run `active-work prompt` — it prints the same bootstrap prompt to stdout, cwd-resolved and side-effect-free (no auto-archive). The bundled `/aw-prompt` slash command wraps it and injects the output straight into the session.

Because handoff and brief excerpt are already in your context, **do not re-read `brief.md` or `handoff.md`** at the top of the session. Jump straight to the highest-rank open task unless the user redirects you. If the user opens a slug without further instruction, ask "continue with `<top task title>`?" and proceed on confirmation.

**Ad-hoc sessions** (`aw <slug> --adhoc`, also `open`/`prompt --adhoc`): the opening and closing directives change to say the session is scoped to ad-hoc work on the workstream — the context is background, *not* a directive. Do **not** offer to continue the top task; wait for the user to describe the specific ad-hoc task, then work it with the workstream context in mind. The bootstrap prompt itself carries this instruction, so follow whichever framing it renders.

## Reference docs

- [onboarding.md](references/onboarding.md) — first-time setup walkthrough
- [auditing-existing-work.md](references/auditing-existing-work.md) — discover + triage flow for catching up on untracked work
- [cli-dev.md](references/cli-dev.md) — internal architecture for skill maintainers and CLI contributors
