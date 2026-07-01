# Architecture

`active-work` is a single npm package that ships four user-facing surfaces — a CLI, an MCP server, an HTTP daemon (which hosts the dashboard and an MCP-over-HTTP transport), and a Claude skill — all backed by a shared command registry and a plain-file data layout.

This document describes the layers, the data model, the concurrency story, and the key flows. Source paths are absolute relative to the repo root.

## Layers

```
                  +-----------------+    +-----------------+    +-----------------+
                  |   CLI           |    |   MCP server    |    |  HTTP daemon    |
                  |  src/cli.ts     |    |  src/server/mcp |    |  src/server/    |
                  +--------+--------+    +--------+--------+    +--------+--------+
                           |                      |                      |
                           v                      v                      v
                  +-----------------------------------------------------------+
                  |             Command registry (zod-typed)                  |
                  |   src/registry/  +  src/commands/<one file per cmd>       |
                  +-----------------------------------------------------------+
                                              |
                                              v
                  +-----------------------------------------------------------+
                  |  Primitives: schemas, fs-atomic, flock, frontmatter I/O   |
                  |   src/schemas/  +  src/utils/                             |
                  +-----------------------------------------------------------+
                                              |
                                              v
                  +-----------------------------------------------------------+
                  |  Filesystem under $XDG_DATA_HOME/active-work/<slug>/      |
                  +-----------------------------------------------------------+
```

The **registry** at `src/registry/index.ts` is the single source of truth for the command surface. Each entry under `src/commands/*.ts` declares a `name` (e.g. `task.add`), zod-typed `args` and `result` schemas, a CLI metadata block (positional + options), and a `run(args, ctx)` implementation. The CLI dispatcher (commander) and the MCP server both build their tool tables by walking `registry.values()` — there is no parallel definition for either.

## Data model

Every initiative is a directory under `$XDG_DATA_HOME/active-work/<slug>/`:

```
<slug>/
  brief.md            # frontmatter (state, rank, title, ship_target, ...) + free prose
  handoff.md          # free prose body, no frontmatter
  tasks/<ID>.yml      # one file per task, ID like FEAT-1, FEAT-2, ...
  sessions/<ts>-<id>.md  # session summaries; frontmatter + body
  artifacts.yml       # PRs / branches / stashes tracked for this initiative
  sources/            # raw source documents (PRs, deepdives, pointers)
```

A top-level `<activeRoot>/.schema-version` file holds the integer schema version. `src/migrations/index.ts` exports `CURRENT_VERSION` and `ensureSchemaVersion(activeRoot)`, which migrates forward in place (writing `.pre-migration-v<N>.bak` backups) and refuses to operate against a future version.

Schema shapes live under `src/schemas/`:

| File | Validates |
|---|---|
| `brief.ts` | `BriefFrontmatterSchema` — state, rank, title, ship_target, owner, task_prefix, worktrees |
| `task.ts` | `TaskSchema` — id, title, priority, severity, estimate, status, tags, notes |
| `session.ts` | `SessionFrontmatterSchema` — session_id, started, ended, track |
| `artifacts.ts` | `ArtifactsSchema` — `{ branches, stashes }` (PR state is derived live via `gh` from `artifact.status`) |
| `state.ts` | `.schema-version` reader |

Conditional refinements ride along with the base schema: `state: 'focused'` requires a `rank`; `state: 'paused'` requires both `paused_since` and `restart_trigger`. The validating writers in `src/utils/gray-matter-io.ts` and `src/utils/yaml-io.ts` reject any write that fails these rules, so the on-disk tree is always coherent.

## Concurrency

Two patterns guard data integrity:

- **Atomic writes.** `atomicWrite(path, content)` in `src/utils/fs-atomic.ts` writes to `<path>.<pid>.<rand>.tmp`, `fsync()`s the temp file, then `rename()`s it into place. Either the old file or the new file exists at every observable moment — there is no torn-write window.
- **Per-initiative locks.** `withFileLock(lockPath, fn)` wraps a read-modify-write critical section in a POSIX advisory lock (`proper-lockfile`). The lock file lives next to the artifact being mutated (e.g. `<slug>/.brief.lock`), so two `active-work focus` invocations against the same initiative serialize, but operations against different initiatives run in parallel.

Lock-then-validate-then-write is the canonical pattern — see `src/commands/_focus-helpers.ts` for the rank-shift implementation, which reads every focused initiative's brief.md, computes the shift, and writes back only the changed files inside one critical section.

## Bootstrap flow

`active-work open <slug>` is the primary entrypoint Claude calls when starting work on an initiative. It assembles a single prompt string containing everything needed to resume:

1. **Resolve the slug.** Exact match wins; otherwise unique prefix; ambiguous prefixes error out.
2. **Read the brief.** Frontmatter summary (state, rank, ship_target, owner) + the first prose paragraph as the excerpt.
3. **Read the handoff.** Full body — this is where the operator (or a previous session) wrote what to do next.
4. **Pull the most recent session.** From `sessions/`, sorted by `ended` descending. Take the first `canonical` entry's body.
5. **Top open tasks.** `tasks/*.yml` filtered to `status: open`, sorted by priority ascending, top N (default 5).
6. **Recent completions.** Done tasks closed in the last 14 days, top 5 — useful context for "what just shipped".
7. **Open artifacts.** `artifacts.yml` PRs whose status isn't `merged` or `closed`.
8. **Time since last session.** Computed from the most recent session's `ended` timestamp (e.g. "3 hours ago").

Implementation is in `src/bootstrap/prompt.ts`. The result is printed to stdout (so the caller can pipe it to `claude <prompt>` or to an MCP client). With no slug, `active-work open` instead launches an interactive picker (clack) and spawns `claude` with the chosen initiative's worktree as cwd.

## Daemon endpoints

The daemon (`active-work mcp serve [--detach]`) is a single hono process bound to `127.0.0.1:7400` (port configurable). It exposes:

| Route | Purpose |
|---|---|
| `GET /health` | Liveness + version + uptime + active port |
| `GET /version` | Daemon version (used by CLI version-check before issuing RPCs) |
| `POST /rpc/:name` | Invoke a registry command by name; body is the args, response is the JSON envelope |
| `GET /ui`, `GET /ui/*` | Serves the bundled dashboard from `dist/dashboard/` (single HTML file) |
| `* /mcp` | Streamable MCP-over-HTTP transport; tool definitions are derived from the registry |

A PID file at `$XDG_STATE_HOME/active-work/daemon.pid` and a metadata file at `daemon.meta.json` let `active-work mcp status|stop|restart` find and signal the running process. macOS users get a launchd plist via `active-work setup` (and Linux users a systemd user unit); the agent/unit re-launches the daemon on login.

The dashboard is read-only at v0 and renders the registry's read endpoints (`list`, `task.list`, `audit`, `artifact.list`) plus a WebSocket subscription on `/ws` for live updates.

## Skill integration

`skill/SKILL.md` is the operator-facing rules document Claude loads automatically when one of the trigger phrases in its frontmatter matches the user's message ("active work", "what am I working on", "bootstrap session", etc.). The frontmatter `description` field holds the trigger list; Claude's skill loader pattern-matches against it.

Installation:

- `scripts/postinstall.js` runs on `npm install -g @hjewkes/active-work`. If `~/.claude/` exists, it copies `skill/` to `~/.claude/skills/active-work/`. Existing installs are replaced (so updates land cleanly).
- `scripts/preuninstall.js` removes `~/.claude/skills/active-work/` on `npm rm`.
- `active-work setup` re-runs the same install logic — useful when the operator installed via a different path or wants to re-register after editing the skill.

Reference docs live at `skill/references/{onboarding,auditing-existing-work,cli-dev}.md` and are pulled in by the skill on demand.

## Migrations

`src/migrations/index.ts` defines:

```ts
export const CURRENT_VERSION = 1;
const MIGRATIONS: Record<number, (root: string) => Promise<void>> = {
  // 0: (root) => migrateV0ToV1(root),
};
export async function ensureSchemaVersion(activeRoot: string): Promise<{
  before: number;
  after: number;
  migrated: boolean;
}>;
```

On every startup that touches the active root, `ensureSchemaVersion` reads `.schema-version`, runs each migration in order from the current version to `CURRENT_VERSION`, and writes the new version. Each migration writes a `.pre-migration-v<N>.bak` snapshot of any file it rewrites, so a failed migration can be rolled back manually.

A version higher than `CURRENT_VERSION` is a hard error — the operator is told to upgrade `@hjewkes/active-work`. v0 stores predate the schema-version file and are treated as v0; the v0 → v1 migration is intentionally absent (operators archive v0 state manually, then run `active-work setup` for a fresh start).

## Cross-references

- Plan: `docs/superpowers/plans/2026-05-12-active-work-v2.md`
- Repo conventions: `CLAUDE.md`
- Skill content: `skill/SKILL.md`
- CLI reference (auto-generated): `docs/cli-reference.md`
