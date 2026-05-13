# active-work

Durable per-initiative workspace state for engineering work — a CLI, an MCP server, an HTTP daemon, a read-only dashboard, and a Claude skill, all in one npm package, so Claude Code sessions can pick up cleanly across days, machines, and contexts.

## Overview

Engineering work spans days or weeks; Claude Code sessions don't. A typical week has handoffs between sessions, between machines, between agents — and every handoff loses context unless something durable holds it. `active-work` is that something. It keeps a small set of plain files per initiative (a brief, a handoff note, tasks, session summaries, tracked artifacts) under `$XDG_DATA_HOME/active-work/<slug>/`, and exposes those files through a CLI (`active-work`), an MCP server, an HTTP daemon, and a Claude skill so that any of those surfaces can read or write the same source of truth.

The headline feature is `aw <slug>` — a one-shot launcher that assembles the bootstrap prompt (brief excerpt, full handoff, last session summary, top open tasks, open artifacts, time since last session) and execs `claude` with the initiative's worktree as cwd. Everything Claude needs to resume work, in one command. The underlying prompt is also available via `active-work open <slug>` for callers that want to handle the spawn themselves. The skill pre-loads the rules and trigger phrases that tell Claude when to engage; the daemon serves the same primitives over MCP so Claude can mutate state (add tasks, mark them done, record session summaries) through tool calls instead of file edits.

State lives as plain markdown + YAML, so anything the tool can write the operator can read in `cat` or edit in `$EDITOR`. Concurrency is handled by atomic writes (tmp + fsync + rename) and per-initiative POSIX advisory locks. Schemas are validated on every write, so the on-disk tree is always coherent.

The package ships everything in one tarball: CLI binary, MCP server, daemon, bundled single-file dashboard, and skill content. One `npm install -g` plus one `active-work setup` and the whole stack is live.

## Install

```bash
npm install -g @hjewkes/active-work
active-work setup
```

`active-work setup` is an interactive wizard that walks through eight steps:

1. **Verify Node version** — Node 22+ required.
2. **Create the active root** — `$XDG_DATA_HOME/active-work/`.
3. **Write the schema version** — `.schema-version` file at version 1.
4. **Write a config stub** — `$XDG_CONFIG_HOME/active-work/config.json` with sensible discovery defaults.
5. **Install the skill** — copy `skill/` into `~/.claude/skills/active-work/` (the npm postinstall already does this if `~/.claude/` exists; this step is idempotent).
6. **Register the MCP server** — adds an entry to your Claude Code MCP config so Claude can call `active-work` tools.
7. **Start the daemon** — launches `active-work mcp serve --detach` and (on macOS) optionally installs a launchd plist so the daemon restarts at login.
8. **Optional ingestion walkthrough** — spawns a Claude session at the active root with a discovery prompt, helpful when adopting `active-work` for an existing pile of in-flight work.

For non-interactive environments (CI, dotfile bootstrap scripts) use `active-work setup --yes`. To re-run after an upgrade and pick up new defaults, use `active-work setup --update`.

## Quickstart

Create an initiative, add a couple of tasks, then bootstrap a Claude session:

```bash
active-work new my-feature --title "My Feature" --ship-target 2026-Q4
active-work task add my-feature --title "Wire up auth" --priority 1 --severity high
active-work task add my-feature --title "Write tests" --priority 2
aw my-feature            # launches `claude` with the bootstrap prompt
```

`active-work new` scaffolds the directory: brief.md (frontmatter + body), handoff.md, an empty tasks/ folder, and an artifacts.yml. `active-work task add` writes a YAML task file with a sequential ID derived from the initiative's `task_prefix` (e.g. `MF-1`, `MF-2`). `aw <slug>` is the launcher: it calls `active-work open <slug>` under the hood to assemble the bootstrap prompt — brief excerpt, full handoff, last session, top open tasks, open artifacts, time since last session — then execs `claude` with that prompt in the initiative's worktree. Run `aw` with no slug to pick interactively. Use `active-work open <slug>` directly when you want the prompt without launching Claude.

When you wrap up a session, capture it:

```bash
active-work session record my-feature --session-id <id> \
  --started 2026-05-12T09:00:00Z --ended 2026-05-12T11:30:00Z \
  --track canonical --body "Wired up the OAuth flow; tests still pending."
```

The skill's "wrap up" / "I'm done" trigger phrases prompt Claude to do this for you automatically.

## Concepts

**Initiatives.** A unit of in-flight work. One slug, one directory under the active root, one set of files. State machine: `focused` → `backburner` → `paused` → `done` (with a `rank` for ordering focused initiatives, and required `paused_since` + `restart_trigger` when paused).

**Briefs.** `brief.md` per initiative — frontmatter with the structured fields (state, rank, ship_target, owner, task_prefix, worktrees), prose body for the operator's freeform context.

**Handoffs.** `handoff.md` per initiative — pure prose, no frontmatter. The "what to do next when you pick this up again" note. Updated freely between sessions.

**Tasks.** `tasks/<ID>.yml`, one file per task. ID is `<task_prefix>-<sequential>`, monotonic and never reused. Fields: title, priority (lower = higher), severity, estimate, status (`open` | `done`), tags, notes.

**Sessions.** `sessions/<YYYY-MM-DD-HHMM>-<session-id>.md` — frontmatter (session_id, started, ended, track) + prose body. The `track: canonical` summaries are what the bootstrap prompt pulls.

**Artifacts.** `artifacts.yml` — tracked PRs, branches, and stashes. `active-work artifact check <slug>` shells out to `gh` to refresh PR statuses.

**Where data lives.** Everything sits under `$XDG_DATA_HOME/active-work/<slug>/` (typically `~/Library/Application Support/active-work/` on macOS, `~/.local/share/active-work/` on Linux). The active root is overridable via the `ACTIVE_ROOT` env var. A small amount of runtime state (daemon PID file, logs) sits under `$XDG_STATE_HOME/active-work/`.

**State + rank.** Focused initiatives have a `rank` (1 = top of mind). Backburner initiatives are reachable by name but don't appear in the focused list. Paused initiatives carry `paused_since` and a `restart_trigger` ("when X happens, unpause"). Done initiatives stay in place until archived to `<archiveRoot>/<domain>/archive/`.

**On-disk shape.** Each initiative is a directory:

```
<activeRoot>/my-feature/
  brief.md                    # frontmatter + prose
  handoff.md                  # prose
  tasks/
    MF-1.yml
    MF-2.yml
  sessions/
    2026-05-12-0930-abc123.md
  artifacts.yml
  sources/
```

## Architecture

`active-work` is built around a shared, zod-typed **command registry**. Every CLI sub-command is defined once under `src/commands/*.ts`; the CLI dispatcher (commander), the MCP server, and the HTTP daemon all consume the same registry. There is no parallel definition for any surface — adding a command in one place wires it everywhere.

The runtime layout: a thin CLI entrypoint, an MCP server (stdio for direct Claude Code use, HTTP-streamable when the daemon is running), and a long-running hono daemon that hosts MCP-over-HTTP, REST RPCs, a WebSocket event stream, and a bundled single-file React dashboard at `http://127.0.0.1:7400/ui`.

See [`docs/architecture.md`](docs/architecture.md) for the full breakdown — layers, data model, concurrency, bootstrap flow, daemon endpoints, skill integration, and migrations.

## Commands

The most-used surface, grouped by purpose. Run `active-work <command> --help` for flags or see the full list in [`docs/cli-reference.md`](docs/cli-reference.md).

| Group | Command | Purpose |
|---|---|---|
| Lifecycle | `active-work new <slug>` | Scaffold a new initiative |
| Lifecycle | `active-work focus <slug> [--rank N]` | Promote into the focused list |
| Lifecycle | `active-work pause <slug> --since ... --restart-trigger ...` | Pause with restart metadata |
| Lifecycle | `active-work archive <slug> <domain>` | Move out of the active root |
| Lifecycle | `active-work list` | List every initiative grouped by state |
| Tasks | `active-work task add <slug> --title ... --priority N` | Add a task |
| Tasks | `active-work task done <slug> <id>` | Mark a task done |
| Tasks | `active-work task list [slug]` | List tasks for an initiative or across all |
| Sessions | `active-work session record <slug> ...` | Capture a session summary |
| Sessions | `aw <slug>` | Launch Claude with the bootstrap prompt |
| Sessions | `active-work open <slug>` | Print the bootstrap prompt to stdout (no claude spawn) |
| Daemon | `active-work mcp serve [--detach]` | Start the HTTP + MCP daemon |
| Daemon | `active-work mcp status` | Health-check the running daemon |
| Daemon | `active-work mcp stop` | Stop the daemon |
| Discover | `active-work discover` | Scan gh / git / projects / Claude sessions for untracked work |
| Discover | `active-work audit` | Cross-initiative health summary |

## Configuration

User-level config lives at `$XDG_CONFIG_HOME/active-work/config.json` (typically `~/Library/Preferences/active-work/config.json` on macOS, `~/.config/active-work/config.json` on Linux). `active-work setup` writes a stub on first run; edit it directly afterward.

```json
{
  "discovery": {
    "githubRepos": ["hjewkes/active-work", "hjewkes/brain"],
    "localRepos": ["~/Documents/projects/active-work"],
    "projectsRoot": "~/Documents/projects"
  }
}
```

`discovery.githubRepos` controls which repos `active-work discover` queries via `gh pr list`. `discovery.localRepos` is the list of local git checkouts to scan for branches, worktrees, and stashes. `discovery.projectsRoot` is the parent directory whose subdirectories are checked against active initiative slugs.

The active root itself is not in this file — it follows the XDG spec and can be overridden with `ACTIVE_ROOT=/some/path` at the env level.

### Using `active-work` from Claude Code via MCP

Once `active-work setup` registers the MCP server, Claude Code can call any registry command as a tool. Tool names are `active__<command>__<subcommand>` (e.g. `active__task__add`, `active__session__record`). Inputs are derived from the same zod schemas that back the CLI flags, so the surface is identical — the only difference is that MCP calls return structured JSON envelopes (`{ ok, data, warnings }` or `{ ok: false, error, code }`) instead of human-formatted output.

The dashboard at `http://127.0.0.1:7400/ui` (served by the daemon) is a read-only React view: list of initiatives by state, per-initiative detail with tasks and sessions, cross-initiative task and artifact rollups, and a live WebSocket subscription so file edits show up immediately.

## Development

```bash
pnpm install
pnpm dev <command>      # tsx-driven dev runner; e.g. pnpm dev list
pnpm test               # full vitest run (unit + integration)
pnpm test:unit          # unit project only
pnpm test:integration   # integration project only
pnpm typecheck
pnpm lint
pnpm build              # tsup CLI bundle + vite dashboard bundle
```

Node 22+, pnpm. The build produces `dist/cli.js` (single ESM bundle) and `dist/dashboard/index.html` (single-file React app).

To regenerate the auto-generated CLI reference after adding or changing a command:

```bash
pnpm build                                 # ensure dist/cli.js is current
node scripts/gen-cli-reference.mjs         # writes docs/cli-reference.md
```

The implementation follows a wave-based plan documented at [`docs/superpowers/plans/2026-05-12-active-work-v2.md`](docs/superpowers/plans/2026-05-12-active-work-v2.md). Repo-specific conventions (lint rules, atomic-write requirements, the "CLI is non-interactive by default" rule) live in [`CLAUDE.md`](CLAUDE.md).

### Project layout

```
src/
  cli.ts                # commander entrypoint; binds the registry
  commands/             # one file per CLI command (registry entries)
  registry/             # registry types + JSON envelope
  schemas/              # zod schemas for brief, task, session, artifacts, state
  utils/                # fs-atomic, flock, frontmatter/YAML I/O, paths, slug
  server/               # hono daemon: HTTP, WS, MCP-over-HTTP
  dashboard/            # React single-file dashboard (vite build)
  bootstrap/            # bootstrap prompt assembly (active-work open)
  discover/             # gh / git / projects / Claude session discovery
  migrations/           # schema-version migration runner
  lint/                 # warn-only artifact lints
  setup/                # setup wizard step implementations
  templates/            # mustache scaffold templates
skill/                  # SKILL.md + reference docs (copied to ~/.claude/)
scripts/                # postinstall, preuninstall, gen-cli-reference
docs/                   # architecture overview + auto-generated CLI reference
__tests__/              # vitest unit + integration tests
```

## Troubleshooting

**`active-work mcp status` says the daemon isn't running.** Start it with `active-work mcp serve --detach`. If it dies again immediately, check the log at `$XDG_STATE_HOME/active-work/daemon.log`. On macOS, `active-work mcp install-launchd` makes the daemon restart automatically at login.

**MCP tools aren't visible in Claude Code.** Verify the registration with `claude mcp list`. If the entry is missing, re-run `active-work setup --update` to re-register. If it's present but tools don't work, check the daemon log and confirm the version matches with `active-work --version` vs `curl http://127.0.0.1:7400/version`.

**Schema version mismatch.** If the on-disk active root was written by a newer build, the CLI will refuse to operate. Upgrade with `npm install -g @hjewkes/active-work@latest`. If the active root is older, `active-work setup` (or any command that touches the root) will run forward migrations automatically.

**`active-work new` complains about an existing slug.** Slugs are unique within the active root. Either pick a different slug or `active-work archive <slug> <domain>` the existing one first.

**Direct file edits got lost or corrupted.** Edits to `tasks/*.yml`, `artifacts.yml`, or `brief.md` frontmatter must go through the CLI so they're schema-validated. Prose bodies (`brief.md` body, `handoff.md`, session summaries) are safe to edit by hand. Use `active-work edit brief <slug>` to open `$EDITOR` with re-validation on save.

## License

MIT — see [`LICENSE`](LICENSE).
