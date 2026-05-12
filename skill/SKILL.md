---
name: active-work
description: |
  Maintain durable per-initiative workspace state (brief, handoff, tasks, sessions, artifacts) so engineering work picks up cleanly across Claude Code sessions. Use when the user mentions: "active work", "what am I working on", "bootstrap session", "new initiative", "record this session", "update handoff", "archive initiative", "check active", "audit my workstreams", "find untracked work", "set up active-work", "add a task", "mark X done", "what's blocking me", "wrap up", "I'm done", or types /active-work.
---

# active-work — durable workspace state across Claude sessions

`active-work` keeps a small filesystem-backed record for every engineering initiative the user has in flight. Files live under `$XDG_DATA_HOME/active-work/<slug>/` and include `brief.md` (frontmatter + prose), `handoff.md` (free prose), `tasks/*.yml`, `sessions/*.md`, `artifacts.yml`, and `sources/`. The CLI is `aw` (long-form alias `active-work`). A long-running daemon, `aw mcp serve`, exposes MCP tools to Claude Code over HTTP and serves a read-only dashboard at `http://127.0.0.1:7400/ui`.

## When to engage

Engage whenever the user signals they want to inspect, mutate, or hand off persistent workspace state. Trigger phrases:

- "active work" / "what am I working on" — list initiatives, surface current focus
- "bootstrap session" / `/active-work` — load the bootstrap prompt for an initiative
- "new initiative" — scaffold a slug with `aw new`
- "add a task" / "mark X done" / "what's blocking me" — task ops via `aw task`
- "record this session" / "update handoff" / "wrap up" / "I'm done" — session capture + handoff
- "archive initiative" — move a slug to the archived state
- "check active" / "audit my workstreams" — `aw audit` health check
- "find untracked work" — `aw discover` across configured sources
- "set up active-work" — first-time install / `aw setup`

## Core rules

1. **Edits route through the CLI.** Use `aw new`, `aw set`, `aw task add`, `aw task done`, `aw artifact add`, etc. Direct `Edit`/`Write` on `tasks/*.yml`, `artifacts.yml`, or the frontmatter of `brief.md` bypasses validation and corrupts the schema. Prose bodies (`brief.md` body, `handoff.md`, session summaries) can be edited directly, but prefer `aw edit` for `brief.md` because it re-validates frontmatter on save.
2. **LLM writes prose; CLI handles structure.** Task ordering, session filenames, frontmatter dates, slug normalization, and rank reflow are CLI primitives. Don't compute them yourself.
3. **`aw --help` is the canonical command reference.** This skill intentionally doesn't duplicate the surface; run `aw --help` or `aw <command> --help` when you need flags.
4. **Session capture at end.** When wrapping up, run `aw session record <slug>` with a 3-5 bullet summary of what happened, what changed, and what's next. Auto-prompt this when you detect the user winding down ("I'm done", "let's stop", "wrap up", inactivity after a chunk of work).
5. **`aw mcp status` first.** If MCP tools aren't responding, the daemon may not be running. Start it with `aw mcp serve --detach` before retrying.

## Bootstrap flow (`aw open <slug>` / `aw-work <slug>`)

`aw open <slug>` (and the convenience launcher `aw-work <slug>`) assembles a bootstrap prompt that inlines:

- The full `handoff.md` text
- A brief excerpt (frontmatter summary + first prose paragraph)
- The most recent session summary
- The top N open tasks (rank-sorted)
- Open artifacts with status
- Time since the last session

Because handoff and brief excerpt are already in your context, **do not re-read `brief.md` or `handoff.md`** at the top of the session. Jump straight to the highest-rank open task unless the user redirects you. If the user opens a slug without further instruction, ask "continue with `<top task title>`?" and proceed on confirmation.

## Reference docs

- [onboarding.md](references/onboarding.md) — first-time setup walkthrough
- [auditing-existing-work.md](references/auditing-existing-work.md) — discover + triage flow for catching up on untracked work
- [cli-dev.md](references/cli-dev.md) — internal architecture for skill maintainers and CLI contributors
