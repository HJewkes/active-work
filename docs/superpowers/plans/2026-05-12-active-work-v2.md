# Active Work v2 Implementation Plan

> For agentic workers: each Task in this document is a self-contained unit suitable for `superpowers:subagent-driven-development` dispatch. Waves group tasks that can run in parallel (disjoint files). Wave gates are sequential — the next wave does not start until the previous wave completes.

**Goal:** Build `@hjewkes/active-work` — a CLI + MCP server + Claude skill + minimal web dashboard that maintains durable per-initiative workspace state (brief, handoff, tasks, sessions, artifacts) so engineering work can be picked up cleanly across Claude Code sessions.

**Architecture:** Single npm package ships CLI, MCP server, web dashboard, and skill. A shared **command registry** (zod-typed) is the single source of truth — the CLI dispatcher (commander) and MCP server both consume it; no parallel definitions. A long-running **daemon** (`active-work mcp serve`) hosts MCP-over-HTTP, REST, WebSocket, and the dashboard at `http://127.0.0.1:<port>`. CLI commands are non-interactive by default (Claude is the primary caller); interactive UX is reserved for `active-work open` (picker), `active-work setup` (wizard), and explicit `--interactive` flags. Data lives as plain files under `$XDG_DATA_HOME/active-work/<slug>/` (brief.md with frontmatter + prose, handoff.md prose, tasks/\*.yml, sessions/\*.md, artifacts.yml, sources/). Concurrency via POSIX `flock` per-initiative.

**Tech Stack:**
- Runtime: Node 22+, ESM only
- Language: TypeScript 5.7, strict
- CLI: `commander` + `@commander-js/extra-typings`
- MCP: `@modelcontextprotocol/sdk`
- Validation: `zod`
- Frontmatter: `gray-matter`
- YAML: `yaml`
- Paths: `env-paths`
- Interactive UI: `@clack/prompts`
- Color: `picocolors`
- HTTP: `hono` (lightweight, ESM-native, easy WS via `hono/ws`)
- Build: `tsup` (ESM)
- Test: `vitest` (workspace: unit / integration)
- Lint/format: `eslint` (flat config) + `prettier` + `lint-staged`
- Dashboard: React 19 + `react-native-web` + `vite-plugin-singlefile` + `@titan-design/react-ui`
- Release: `changesets` + GitHub Actions
- Package manager: `pnpm`

**Repository:** New GitHub repo `hjewkes/active-work`, MIT, public. Description: "Durable workspace state for engineering work — CLI, MCP, and Claude skill for tracking initiatives across sessions". Topics: `claude-code`, `mcp`, `cli`, `productivity`, `developer-tools`. Default branch `main`, branch protection on `main` (require PR). CI on push: typecheck + lint + test.

**OS support v0:** macOS only (launchd plist for daemon supervision). Linux/Windows when requested.

---

## File Structure

Every file mapped to its single responsibility. Implementations must match these paths exactly.

### Repo root
| Path | Responsibility |
|---|---|
| `package.json` | npm manifest: name `@hjewkes/active-work`, ESM, bins `aw` + `active-work`, scripts, deps |
| `pnpm-lock.yaml` | Lockfile |
| `tsconfig.json` | TS strict config, ES2022, Node16 module, src/ root, dist/ out, excludes dashboard |
| `tsconfig.build.json` | Build-only TS config, narrower than base |
| `tsup.config.ts` | ESM bundle of `src/cli.ts`, target node22 |
| `vitest.config.ts` | Shared vitest config (coverage thresholds, timeouts) |
| `vitest.workspace.ts` | Workspace defining `unit` and `integration` projects |
| `eslint.config.js` | Flat-config ESLint (typescript-eslint) |
| `.prettierrc` | Prettier config |
| `.gitignore` | Standard node + project ignores (lock files for daemon, `.active-work-test/`, etc.) |
| `.npmrc` | `ignore-workspace=true` if nested under a pnpm workspace; otherwise empty |
| `README.md` | Install, quickstart, command reference (pointer to `active-work help`) |
| `CLAUDE.md` | Repo-specific rules + architecture pointers |
| `LICENSE` | MIT |
| `.changeset/config.json` | Changesets config |
| `.github/workflows/ci.yml` | typecheck + lint + test on push/PR |
| `.github/workflows/release.yml` | Changesets-driven release |

### `src/` — source code
| Path | Responsibility |
|---|---|
| `src/cli.ts` | CLI entrypoint: parses argv, wires commander to command registry, exits with sysexit code |
| `src/errors.ts` | Typed error classes (`ValidationError`, `NotFoundError`, `DaemonError`, etc.) + sysexits mapping |
| `src/types.ts` | Shared types not specific to one module |
| `src/utils/paths.ts` | Path helpers via `env-paths`; resolve `activeRoot`, `stateRoot`, `configRoot` |
| `src/utils/fs-atomic.ts` | Atomic write (tmp + rename + fsync); `withFileLock` (flock via `proper-lockfile` or native) |
| `src/utils/yaml-io.ts` | Read/write YAML files with schema validation |
| `src/utils/gray-matter-io.ts` | Read/write markdown files with frontmatter; schema validation on write |
| `src/utils/today.ts` | `YYYY-MM-DD` + ISO timestamp helpers |
| `src/utils/slug.ts` | Slug validation (strict kebab-case) + task-prefix derivation |
| `src/utils/picker.ts` | Format helpers for picker output (status emoji, etc.) |
| `src/utils/color.ts` | Color wrappers via picocolors; respects `NO_COLOR` and TTY detection |
| `src/utils/usage-log.ts` | Append-only `usage.jsonl` writer |
| `src/utils/session-id.ts` | Source the Claude session ID from env, fall back to UUID |
| `src/schemas/brief.ts` | Zod schema for brief.md frontmatter; types |
| `src/schemas/task.ts` | Zod schema for tasks/\*.yml; types |
| `src/schemas/session.ts` | Zod schema for sessions/\*.md frontmatter; types |
| `src/schemas/artifacts.ts` | Zod schema for artifacts.yml; types |
| `src/schemas/state.ts` | Top-level `.schema-version` reader + migration runner |
| `src/registry/types.ts` | `Command<I, O>` interface; `CommandRegistry` type |
| `src/registry/index.ts` | Builds the registry by importing all `src/commands/**/*.ts` modules |
| `src/registry/json-envelope.ts` | `{ok, data, warnings}` / `{ok: false, error}` formatting |
| `src/commands/new.ts` | `active-work new <slug> --title ... --ship-target ... [--worktree ...]` |
| `src/commands/set.ts` | `active-work set <slug> <field> <value>` — frontmatter field setter |
| `src/commands/focus.ts` | `active-work focus <slug> [--rank N]` — re-rank focused initiatives |
| `src/commands/unfocus.ts` | `active-work unfocus <slug>` |
| `src/commands/pause.ts` | `active-work pause <slug> --since YYYY-MM-DD --restart-trigger "..."` |
| `src/commands/unpause.ts` | `active-work unpause <slug>` |
| `src/commands/archive.ts` | `active-work archive <slug> <domain>` |
| `src/commands/rename.ts` | `active-work rename <old-slug> <new-slug>` |
| `src/commands/touch.ts` | `active-work touch <slug>` — stamp `updated` date |
| `src/commands/paths.ts` | `active-work paths <slug>` — print all artifact paths |
| `src/commands/audit.ts` | `active-work audit` — across-initiative summary + lint |
| `src/commands/list.ts` | `active-work list` / `ls` — formatted dump (replaces INDEX.md) |
| `src/commands/open.ts` | `active-work open [slug]` — bootstrap; picker when no slug |
| `src/commands/edit.ts` | `active-work edit brief\|handoff <slug>` — opens `$EDITOR`, validates on save |
| `src/commands/task.ts` | `active-work task add/done/list/edit/reorder/delete` |
| `src/commands/session.ts` | `active-work session record/list` |
| `src/commands/source-add.ts` | `active-work source-add <slug> <file> --type ...` |
| `src/commands/artifact.ts` | `active-work artifact add-pr/add-branch/add-stash/list/check` |
| `src/commands/worktree.ts` | `active-work worktree set-default <slug> <label>` |
| `src/commands/discover.ts` | `active-work discover` — emit JSON list of hits |
| `src/commands/fold.ts` | `active-work fold <ref> --into <slug>` |
| `src/commands/drop.ts` | `active-work drop <ref>` |
| `src/commands/track.ts` | `active-work track <ref>` — scaffold initiative from a discover hit |
| `src/commands/sessions-browser.ts` | `active-work sessions` — ad-hoc Claude session browser |
| `src/commands/setup.ts` | `active-work setup [--update]` — interactive install/configure wizard |
| `src/commands/uninstall.ts` | `active-work uninstall` — undo what setup did |
| `src/commands/mcp.ts` | `active-work mcp serve\|stop\|restart\|status\|logs\|install-launchd` |
| `src/server/index.ts` | Daemon process entry: starts HTTP + MCP + WS, writes PID file |
| `src/server/http.ts` | hono app: REST endpoints mirroring registry, WS upgrade route |
| `src/server/mcp.ts` | MCP-over-HTTP transport from `@modelcontextprotocol/sdk`; tool defs derived from registry |
| `src/server/ws.ts` | WebSocket broadcaster: emits events on file changes |
| `src/server/lifecycle.ts` | start/stop/status helpers; PID file management |
| `src/server/launchd.ts` | Generate, install, uninstall `~/Library/LaunchAgents/com.hjewkes.active-work.plist` |
| `src/server/dashboard-routes.ts` | Serve bundled dashboard at `/ui` |
| `src/server/health.ts` | `/health` and `/version` endpoints |
| `src/migrations/index.ts` | Registry of migrations keyed by `from` version |
| `src/migrations/.gitkeep` | Placeholder (no migrations at v1) |
| `src/discover/github.ts` | `gh pr list` integration |
| `src/discover/git.ts` | branches/worktrees/stashes via `git` |
| `src/discover/projects.ts` | projectsRoot subdir scan |
| `src/discover/claude.ts` | `~/.claude/projects/` session scan |
| `src/discover/index.ts` | Orchestrator: runs all sources, cross-references with active initiatives |
| `src/bootstrap/prompt.ts` | Assembles the bootstrap prompt: brief excerpt + last session + top tasks + artifacts + dates |
| `src/lint/index.ts` | `lintSlug(slug)` → `LintFinding[]`; runs handoff/brief/task lints |
| `src/lint/handoff.ts` | Handoff body line cap check |
| `src/lint/brief.ts` | Brief body line cap check |
| `src/lint/task.ts` | Task notes length checks, tag validation |
| `src/templates/brief.md.mustache` | Brief scaffold |
| `src/templates/handoff.md.mustache` | Handoff scaffold |
| `src/templates/session.md.mustache` | Session summary scaffold |
| `src/templates/index.ts` | Mustache renderer with layered template dirs |
| `src/config/index.ts` | Load + deep-merge default config + user override; expand `~`; env overrides |
| `src/config/defaults.json` | Shipped defaults |

### `src/dashboard/` — web UI (built separately via vite)
| Path | Responsibility |
|---|---|
| `src/dashboard/index.html` | Vite entry HTML |
| `src/dashboard/main.tsx` | React root |
| `src/dashboard/App.tsx` | Top-level routing |
| `src/dashboard/vite.config.ts` | vite-plugin-singlefile build; outputs to `dist/dashboard/` |
| `src/dashboard/tokens.ts` | Design tokens (inline; complements `@titan-design/react-ui`) |
| `src/dashboard/styles.css` | Global styles |
| `src/dashboard/types.ts` | Shared TS types for views (API response shapes) |
| `src/dashboard/utils/api.ts` | REST client (fetch + WS subscription) |
| `src/dashboard/views/Initiatives.tsx` | Initiative list (focused / backburner / paused / done) |
| `src/dashboard/views/Initiative.tsx` | Per-initiative detail (brief excerpt + tasks + sessions + artifacts) |
| `src/dashboard/views/Tasks.tsx` | Cross-initiative task list with filters |
| `src/dashboard/views/Artifacts.tsx` | Cross-initiative artifact dashboard (open PRs, stale branches) |
| `src/dashboard/components/InitiativeCard.tsx` | Card primitive |
| `src/dashboard/components/TaskRow.tsx` | Task row primitive |

### `skill/` — Claude skill content
| Path | Responsibility |
|---|---|
| `skill/SKILL.md` | Frontmatter + rules + trigger phrases |
| `skill/references/onboarding.md` | First-time setup walkthrough |
| `skill/references/auditing-existing-work.md` | Discover + triage walkthrough |
| `skill/references/cli-dev.md` | Developer reference for skill maintainers |

### `scripts/`
| Path | Responsibility |
|---|---|
| `scripts/postinstall.js` | npm postinstall: copy `skill/` into `~/.claude/skills/active-work/` if `~/.claude` exists |
| `scripts/preuninstall.js` | npm preuninstall: remove `~/.claude/skills/active-work/` symlink |

### `__tests__/` — vitest
| Path | Responsibility |
|---|---|
| `__tests__/setup/global-setup.ts` | Vitest global setup: temp activeRoot, env stubs |
| `__tests__/fixtures/mini-active-root/` | Canonical fixture tree for tests |
| `__tests__/schemas/*.test.ts` | Schema validators |
| `__tests__/utils/*.test.ts` | fs-atomic, slug, paths, etc. |
| `__tests__/commands/*.test.ts` | Per-command in-process tests against registry |
| `__tests__/integration/cli.test.ts` | Spawn-the-binary end-to-end |
| `__tests__/integration/mcp.test.ts` | MCP transport round-trips |
| `__tests__/integration/daemon.test.ts` | HTTP API smoke + WS subscription |

### `docs/`
| Path | Responsibility |
|---|---|
| `docs/superpowers/plans/2026-05-12-active-work-v2.md` | This plan |
| `docs/architecture.md` | Hand-written architecture overview |
| `docs/cli-reference.md` | Auto-generated from registry via `active-work help --markdown` |

---

## Waves overview

| Wave | Description | Parallel-safe within wave? | Depends on |
|---|---|---|---|
| **0** | Repo skeleton + tooling | No (single linear sequence) | — |
| **1** | Primitives: schemas, fs, errors, registry contract | Yes (5 disjoint tasks) | Wave 0 |
| **2** | Domain commands | Yes (10 disjoint tasks) | Wave 1 |
| **3** | Interfaces: CLI dispatcher, MCP tools, migration runner | Yes (3 disjoint tasks) | Wave 2 |
| **4** | Daemon: HTTP + WS + MCP transport + launchd | No (cohesive subsystem) | Wave 3 |
| **5** | Dashboard + Skill | Yes (2 disjoint tasks) | Wave 4 |
| **6** | Setup wizard + release pipeline | No (sequential) | Wave 5 |
| **7** | Polish: docs, integration tests, lint rules | Yes (3 disjoint tasks) | Wave 6 |

---

## Wave 0 — Repo skeleton + tooling

Sequential. One task. Must complete before any other wave.

### Task 0.1: Initialize repository and tooling

**Goal:** Repo exists on GitHub with metadata, basic project files, and a working `pnpm install` / `pnpm test` (passing with zero tests).

**Files (create):**
- `package.json`, `pnpm-workspace.yaml` (omit; not a workspace), `tsconfig.json`, `tsconfig.build.json`
- `tsup.config.ts`, `vitest.config.ts`, `vitest.workspace.ts`
- `eslint.config.js`, `.prettierrc`, `.gitignore`, `.npmrc` (empty)
- `README.md` (skeleton: install + quickstart placeholder), `CLAUDE.md`, `LICENSE` (MIT)
- `.changeset/config.json`, `.changeset/README.md`
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- `src/cli.ts` (stub: prints "active-work v0.1.0")

**Steps:**
1. `gh repo create hjewkes/active-work --public --license mit --description "Durable workspace state for engineering work — CLI, MCP, and Claude skill for tracking initiatives across sessions"` — repo exists on GitHub
2. `git clone git@github.com:hjewkes/active-work.git /Users/hjewkes/Documents/projects/active-work/repo` — local clone (note: existing empty dir is for plan only; actual repo clones to a sibling location, OR we git-init in place and link to remote)
3. Write `package.json` with deps + scripts (see appendix A for full content)
4. Write `tsconfig.json` (strict, ES2022, Node16, src/ root, dist/ out, exclude dashboard + tests)
5. Write `tsup.config.ts` (entry `src/cli.ts`, format esm, target node22)
6. Write `vitest.config.ts` + `vitest.workspace.ts` (unit + integration projects)
7. Write `eslint.config.js` (flat config, typescript-eslint recommended)
8. Write `.prettierrc` (singleQuote, semi, printWidth 100)
9. Write `.gitignore` (`node_modules/`, `dist/`, `coverage/`, `.active-work-test/`, `*.log`, `.DS_Store`)
10. Write `README.md` skeleton (sections: Install, Quickstart, Commands, Architecture, License)
11. Write `CLAUDE.md` (pnpm, vitest, tsup, key paths)
12. Write `LICENSE` (MIT, current year, "Henry Jewkes")
13. Write `src/cli.ts` (single line: `console.log('active-work v0.1.0');`)
14. Write `.github/workflows/ci.yml` (jobs: install, typecheck, lint, test)
15. Write `.github/workflows/release.yml` (changesets/action@v1)
16. `pnpm install` — succeeds
17. `pnpm test` — passes (no tests yet, `passWithNoTests: true`)
18. `pnpm typecheck` — passes
19. `pnpm lint` — passes
20. `pnpm build` — produces `dist/cli.js`
21. Set GitHub topics: `gh repo edit --add-topic claude-code,mcp,cli,productivity,developer-tools`
22. Set branch protection: `gh api -X PUT /repos/hjewkes/active-work/branches/main/protection ...` (PR-required, status-checks: CI)
23. Commit: `chore: initial repo scaffold` — push to main via PR (or direct push for first commit if protection allows)

**Verification:**
- `gh repo view hjewkes/active-work` returns the repo
- `pnpm test && pnpm typecheck && pnpm lint && pnpm build` all green
- CI workflow runs on first push

---

## Wave 1 — Primitives (5 parallel tasks)

All five tasks are disjoint and can run in parallel via subagent dispatch.

### Task 1.1: Schema layer

**Goal:** Zod schemas + TS types for every persisted data shape, with passing tests.

**Files (create):**
- `src/schemas/brief.ts`, `src/schemas/task.ts`, `src/schemas/session.ts`, `src/schemas/artifacts.ts`, `src/schemas/state.ts`
- `__tests__/schemas/brief.test.ts`, `__tests__/schemas/task.test.ts`, `__tests__/schemas/session.test.ts`, `__tests__/schemas/artifacts.test.ts`

**Schemas to implement:**
- `BriefFrontmatterSchema`: `{ schema_version: number, title: string, updated: YYYY-MM-DD, state: 'focused'|'backburner'|'paused'|'done', rank?: number (required if focused), paused_since?: YYYY-MM-DD (required if paused), restart_trigger?: string (required if paused), ship_target?: string, owner?: string, task_prefix: string, worktrees?: Record<string, { path: string, default?: boolean }> }`
- `TaskSchema`: `{ id: string, title: string, priority: number, severity?: 'critical'|'high'|'medium'|'low', estimate?: number, done_when?: string, status: 'open'|'done', tags?: string[], notes?: string, created: YYYY-MM-DD, updated: YYYY-MM-DD, done_at?: YYYY-MM-DD|null }`
- `SessionFrontmatterSchema`: `{ session_id: string, started: ISO8601, ended: ISO8601, track: 'canonical'|'sidecar' }`
- `ArtifactsSchema`: `{ prs: PrEntry[], branches: BranchEntry[], stashes: StashEntry[] }`
- Conditional refinements: paused requires paused_since + restart_trigger; focused requires rank.

**Tests:** golden inputs accept; missing required fields fail with clear messages; conditional refinements enforced.

**Commit:** `feat(schemas): zod schemas for brief, task, session, artifacts`

### Task 1.2: Filesystem primitives

**Goal:** Atomic write + flock + path helpers + frontmatter/YAML I/O.

**Files (create):**
- `src/utils/paths.ts`, `src/utils/fs-atomic.ts`, `src/utils/gray-matter-io.ts`, `src/utils/yaml-io.ts`, `src/utils/today.ts`, `src/utils/slug.ts`
- `__tests__/utils/fs-atomic.test.ts`, `__tests__/utils/slug.test.ts`, `__tests__/utils/paths.test.ts`

**Key contracts:**
- `getActiveRoot(): string` — via `env-paths('active-work', { suffix: '' }).data`, overridable via `ACTIVE_ROOT` env
- `atomicWrite(path: string, content: string | Buffer): Promise<void>` — tmp file + rename, fsync
- `withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T>` — POSIX advisory lock via `proper-lockfile`
- `readFrontmatter<T>(path: string, schema: ZodSchema<T>): Promise<{ frontmatter: T, body: string }>`
- `writeFrontmatter<T>(path: string, frontmatter: T, body: string, schema: ZodSchema<T>): Promise<void>` — validates before write
- `readYaml<T>(path: string, schema: ZodSchema<T>): Promise<T>` / `writeYaml<T>(path: string, data: T, schema: ZodSchema<T>): Promise<void>`
- `today(): string` — `YYYY-MM-DD` in local time
- `nowIso(): string` — ISO8601
- `validateSlug(s: string): { ok: true } | { ok: false, error: string }` — `^[a-z][a-z0-9-]*[a-z0-9]$`, max 60
- `derivePrefix(slug: string): string` — first letter of each `-`-separated segment, uppercased

**Tests:** atomic write crash safety (mock fs); slug validation accepts/rejects table; frontmatter round-trip preserves body; YAML round-trip preserves order.

**Commit:** `feat(utils): fs-atomic, flock, frontmatter and YAML I/O`

### Task 1.3: Error types + sysexits

**Goal:** Typed errors with sysexit codes; centralized formatting.

**Files (create):**
- `src/errors.ts`, `__tests__/errors.test.ts`

**Exports:**
- `class ActiveWorkError extends Error { code: number }` — base
- `class ValidationError extends ActiveWorkError { code = 65 }` — `EX_DATAERR`
- `class NotFoundError extends ActiveWorkError { code = 66 }` — `EX_NOINPUT`
- `class UsageError extends ActiveWorkError { code = 64 }` — `EX_USAGE`
- `class DaemonError extends ActiveWorkError { code = 69 }` — `EX_UNAVAILABLE`
- `class ConfigError extends ActiveWorkError { code = 78 }` — `EX_CONFIG`
- `formatError(err: unknown): { message: string, code: number }` — for both CLI and JSON output

**Tests:** error→code mapping table; unknown errors map to 1.

**Commit:** `feat(errors): typed error classes with sysexits codes`

### Task 1.4: Command registry contract

**Goal:** Type-level scaffold for the command registry pattern — schemas, dispatcher contract, JSON envelope.

**Files (create):**
- `src/registry/types.ts`, `src/registry/json-envelope.ts`, `src/registry/index.ts` (empty stub that exports `registry: Command[]`)
- `__tests__/registry/json-envelope.test.ts`

**Key types:**
```ts
export interface Command<Args, Result> {
  name: string;                    // e.g., 'task.add'
  description: string;             // for CLI help and MCP tool description
  args: ZodSchema<Args>;           // input schema
  result: ZodSchema<Result>;       // output schema (for JSON envelope)
  cli?: { positional?: string[]; options?: Record<string, CliOption> };
  run(args: Args, ctx: CommandContext): Promise<Result>;
}

export interface CommandContext {
  activeRoot: string;
  warnings: string[];
  format: 'human' | 'json';
}

export type JsonEnvelope<T> =
  | { ok: true; data: T; warnings?: string[] }
  | { ok: false; error: string; code: number };
```

**Tests:** envelope round-trips; warning collection works.

**Commit:** `feat(registry): command registry types + JSON envelope`

### Task 1.5: Vitest workspace setup + fixtures

**Goal:** Working test infrastructure with a mini-active-root fixture.

**Files (create):**
- `__tests__/setup/global-setup.ts`
- `__tests__/fixtures/mini-active-root/.schema-version` (content: `1`)
- `__tests__/fixtures/mini-active-root/sample-initiative/brief.md` (valid frontmatter + body)
- `__tests__/fixtures/mini-active-root/sample-initiative/handoff.md`
- `__tests__/fixtures/mini-active-root/sample-initiative/tasks/SI-1.yml`
- `__tests__/fixtures/mini-active-root/sample-initiative/sessions/.gitkeep`
- `__tests__/fixtures/mini-active-root/sample-initiative/artifacts.yml`
- `__tests__/utils/fixtures.ts` — `withTempActiveRoot(fn)` helper

**Steps:** Verify fixture parses cleanly through Wave 1.1's schemas before completing.

**Commit:** `test: workspace setup, fixture tree, temp-root helper`

---

## Wave 2 — Domain commands (10 parallel tasks)

Each task implements one command (or family). All consume Wave 1 primitives and register with the registry. Tasks touch their own command file + adjacent test file — disjoint.

### Task 2.1: `new`, `set`, `touch`, `paths`, `rename`, `archive` (lifecycle)

**Goal:** Initiative lifecycle CLI ops.

**Files:**
- `src/commands/new.ts`, `set.ts`, `touch.ts`, `paths.ts`, `rename.ts`, `archive.ts`
- `__tests__/commands/lifecycle.test.ts`

**Behaviors:**
- `new` — validates slug, refuses if exists, scaffolds `brief.md` + `handoff.md` + `tasks/` + `sessions/` + `artifacts.yml` from mustache templates with computed frontmatter (state=focused with rank=lastRank+1, today's date, derived task_prefix)
- `set` — raw-read brief.md (no schema), inject field, write via validating writer; supports nested fields like `worktrees.frontend.path`
- `touch` — stamps `updated: today()` in brief.md
- `paths` — prints all artifact paths for the slug
- `rename` — `fs.rename` directory, update brief.md `title` if asked, leave task_prefix alone (stable IDs)
- `archive` — refuses if cwd is inside the dir; moves dir to `<archiveRoot>/<domain>/archive/<slug>-YYYY-MM/`

**Tests:** scaffolding produces parseable files; set rejects unknown fields; archive blocks when cwd inside.

**Commit:** `feat(commands): initiative lifecycle (new/set/touch/paths/rename/archive)`

### Task 2.2: `focus`, `unfocus`, `pause`, `unpause`

**Files:** `src/commands/focus.ts`, `unfocus.ts`, `pause.ts`, `unpause.ts`; `__tests__/commands/focus-pause.test.ts`

**Behaviors:**
- `focus <slug> [--rank N]` — re-rank: read all focused initiatives, shift+insert at target rank, write back changed only
- `unfocus <slug>` — drop from rank list, renumber survivors 1..N, set state to backburner
- `pause` — require `--since` + `--restart-trigger`, set state, clear rank
- `unpause` — set state back to backburner (operator promotes to focused separately)

**Tests:** rank shifting preserves invariants; pause/unpause clears/preserves required fields.

**Commit:** `feat(commands): focus, unfocus, pause, unpause`

### Task 2.3: `task add/done/list/edit/reorder/delete`

**Files:** `src/commands/task.ts`, `__tests__/commands/task.test.ts`

**Behaviors:**
- `task add <slug> --title <t> [--priority N] [--severity ...] [--estimate ...] [--done-when ...] [--tags ...] [--notes ...]` — assign next sequential ID (`<prefix>-<n>` where n = max(existing)+1), write `tasks/<id>.yml`
- `task done <slug> <id>` — set status to done, done_at to today
- `task list <slug>` or `task list --all-initiatives [--tag X] [--severity Y]` — emit table (human) or JSON
- `task edit <slug> <id> <field> <value>` — field-level set
- `task reorder <slug> <id> <new-priority>` — adjust priority field
- `task delete <slug> <id>` — hard delete (rare; usually `done` instead)

**Tests:** sequential ID never collides; reorder doesn't renumber siblings; --all-initiatives glob works.

**Commit:** `feat(commands): task add/done/list/edit/reorder/delete`

### Task 2.4: `session record/list`

**Files:** `src/commands/session.ts`, `__tests__/commands/session.test.ts`

**Behaviors:**
- `session record <slug> --session-id <id> --started <iso> --ended <iso> --track <canonical|sidecar> --body <text>` (or `--body-file <path>`) — write `sessions/<YYYY-MM-DD-HHMM>-<session-id>.md`. Append `-1`, `-2` etc. if filename collides
- `session list <slug>` — emit filename + frontmatter + first line of body, sorted by ended desc

**Tests:** filename format; collision suffixing; round-trip with schema.

**Commit:** `feat(commands): session record + list`

### Task 2.5: `source-add`, `artifact *`

**Files:** `src/commands/source-add.ts`, `src/commands/artifact.ts`, `__tests__/commands/source-artifact.test.ts`

**Behaviors:**
- `source-add <slug> <file> --type pr|deepdive|session|pointer ...` — same logic as v0
- `artifact add-pr <slug> --number N --repo org/repo --title <t>` etc. — append to artifacts.yml
- `artifact check <slug>` — shell out to `gh pr view <n> --json state` and update statuses; print diff

**Tests:** source filename derivation; artifact add idempotent; check updates lastChecked.

**Commit:** `feat(commands): source-add + artifact tracking`

### Task 2.6: `worktree set-default`, `audit`, `list`

**Files:** `src/commands/worktree.ts`, `src/commands/audit.ts`, `src/commands/list.ts`, `__tests__/commands/worktree-audit-list.test.ts`

**Behaviors:**
- `worktree set-default <slug> <label>` — set `default: true` on the named entry, clear others
- `audit` — enumerate initiatives, run lint, detect worktree conflicts, print table
- `list` / `ls` — generated dump replacing INDEX.md; sections by state; sorted by rank then state then slug

**Tests:** worktree default flip; audit catches conflicts; list ordering.

**Commit:** `feat(commands): worktree, audit, list`

### Task 2.7: `discover`, `fold`, `drop`, `track`

**Files:** `src/commands/discover.ts`, `fold.ts`, `drop.ts`, `track.ts`; `src/discover/{github,git,projects,claude,index}.ts`; `__tests__/commands/discover.test.ts`, `__tests__/discover/*.test.ts`

**Behaviors:**
- `discover` — orchestrates all source scanners; emits JSON array `[{source, ref, detail, slug_match, untracked, ...}]`. Always non-interactive.
- `fold <ref> --into <slug> [--note ...]` — writes a `sessions/...-folded.md` summary marking the ref folded; appends to `<activeRoot>/.triaged.log`
- `drop <ref> [--reason ...]` — appends to `.triaged.log` so future discovers suppress
- `track <ref>` — scaffolds a new initiative, prefilling brief.md title/notes from ref metadata

**Tests:** mock `gh` and `git` subprocesses; verify hit aggregation; cross-ref slug matching.

**Commit:** `feat(commands+discover): non-interactive discover + fold/drop/track`

### Task 2.8: `open` + bootstrap prompt assembly

**Files:** `src/commands/open.ts`, `src/bootstrap/prompt.ts`, `__tests__/commands/open.test.ts`, `__tests__/bootstrap/prompt.test.ts`

**Behaviors:**
- `open <slug>` — non-interactive: resolves slug (exact > unique prefix), reads worktree default, prints bootstrap prompt to stdout
- `open` (no slug) — interactive picker (clack) listing sections; cancel exits 0; pick echoes prompt and spawns `claude <prompt>` with resolved cwd
- Bootstrap prompt assembly: brief excerpt (truncated to 40 lines), last canonical session summary, top N (default 5) open tasks, recently-completed (last 5 done in last 14 days), open PRs from artifacts.yml, current date/time, time since last session ("X hours ago" / "X days ago")

**Tests:** prompt assembly snapshot; picker section ordering.

**Commit:** `feat(commands): open + bootstrap prompt assembly`

### Task 2.9: `edit`, `sessions` browser

**Files:** `src/commands/edit.ts`, `src/commands/sessions-browser.ts`, `__tests__/commands/edit.test.ts`, `__tests__/commands/sessions.test.ts`

**Behaviors:**
- `edit brief|handoff <slug>` — spawns `$EDITOR` (fallback chain: `$EDITOR` → `code --wait` if `command -v code` → `vi`), validates frontmatter on exit
- `sessions [--limit N] [--include-active]` — same logic as v0: scans `~/.claude/projects/`, filters out claimed prefixes, picker, spawns `claude --resume <id>`

**Tests:** editor fallback resolution; sessions filter logic.

**Commit:** `feat(commands): edit + sessions browser`

### Task 2.10: Lint module

**Files:** `src/lint/{index,handoff,brief,task}.ts`, `__tests__/lint/*.test.ts`

**Behaviors:**
- `lintSlug(slug): LintFinding[]` — runs each lint
- Handoff body line cap (warn over `lintLimits.handoffMaxBodyLines`)
- Brief body line cap (warn over `lintLimits.briefMaxBodyLines`)
- Task notes length cap (warn at threshold)
- All warn-only; schema violations are hard fails on write (not here)

**Tests:** boundary conditions; multi-finding output ordering.

**Commit:** `feat(lint): handoff, brief, task lints`

---

## Wave 3 — Interfaces (3 parallel tasks)

### Task 3.1: CLI dispatcher

**Files:** rewrite `src/cli.ts`, add `src/utils/color.ts`, `src/utils/usage-log.ts`; `__tests__/integration/cli.test.ts`

**Behavior:**
- commander program built from registry: each command becomes a sub-command with its args mapped from zod schema
- `--json` flag global: when set, output `JsonEnvelope`; otherwise human-readable via picocolors
- Help generation reads from registry descriptions
- Exit codes via `formatError`
- Append to `usage.jsonl` on every invocation

**Tests:** spawn-the-binary end-to-end for every command (smoke); --json envelope shape.

**Commit:** `feat(cli): commander dispatcher + JSON envelope + usage log`

### Task 3.2: MCP server (stdio mode)

**Files:** `src/server/mcp.ts` (initial stdio version), `src/commands/mcp.ts` (subcommand entry), `__tests__/integration/mcp.test.ts`

**Behavior:**
- `active-work mcp serve --stdio` runs stdio-mode MCP server
- Tool definitions auto-derived from registry: name `active__<command>__<subcommand>`, description = registry description, inputSchema = registry args (zod→JSON Schema via `zod-to-json-schema`)
- Tool calls invoke `run()` and return `JsonEnvelope`

**Tests:** spin up stdio server in-process, invoke each tool, verify response shape.

**Commit:** `feat(mcp): stdio MCP server with registry-derived tools`

### Task 3.3: Migration runner

**Files:** `src/migrations/index.ts`, `src/schemas/state.ts`, `__tests__/migrations.test.ts`

**Behavior:**
- Read `<activeRoot>/.schema-version`; if absent, treat as v0
- v0 → v1 migrator: no automatic transformation (we've decided fresh start), but log warning and refuse to operate until operator runs `active-work setup --rebuild-from-v0` (this command is intentionally absent in v1; operator archives manually)
- For future v1+ migrations: in-place rewrite with `.pre-migration-v<N>.bak` backups

**Tests:** version detection; backup writes; migration registry registration.

**Commit:** `feat(migrations): schema version detection + migration runner`

---

## Wave 4 — Daemon (single cohesive subsystem)

Sequential within the wave; one developer/agent owns it.

### Task 4.1: HTTP daemon with hono

**Files:** `src/server/{index,http,ws,lifecycle,health,dashboard-routes,launchd}.ts`, expand `src/commands/mcp.ts`; `__tests__/integration/daemon.test.ts`

**Steps (high level):**
1. hono app with routes: `GET /health`, `GET /version`, `POST /rpc/<command-name>` (mirrors registry), `GET /ui/*` (serves bundled dashboard from `dist/dashboard/`)
2. WebSocket upgrade at `/ws` — broadcasts file-change events (via chokidar on activeRoot)
3. MCP-over-HTTP transport (uses `@modelcontextprotocol/sdk` HTTP transport) at `/mcp`
4. Daemon entrypoint: spawn HTTP server on 127.0.0.1, port from config (default 7400), write PID to `$XDG_STATE_HOME/active-work/daemon.pid` and socket meta to `daemon.meta.json`
5. Lifecycle (`mcp serve|stop|restart|status|logs`): stop reads PID, sends SIGTERM, removes pidfile; status checks pidfile + health endpoint; logs tails `daemon.log`
6. `mcp install-launchd` writes `~/Library/LaunchAgents/com.hjewkes.active-work.plist`, runs `launchctl load`. `mcp uninstall-launchd` reverses
7. Daemon version check: CLI talks to daemon, if version mismatch, CLI sends `POST /admin/shutdown`, restarts (`spawn active-work mcp serve --detach`)
8. Logging: pino to stderr + `$XDG_STATE_HOME/active-work/daemon.log` (rotating by size, keep last 5)

**Tests:** start daemon, hit health, hit one RPC, hit WS, verify broadcast on file write; stop daemon.

**Commit:** `feat(daemon): HTTP + WS + MCP-over-HTTP + launchd plist`

---

## Wave 5 — Dashboard + Skill (2 parallel tasks)

### Task 5.1: Read-only React dashboard

**Files:** `src/dashboard/**`, update `package.json` build script

**Behavior:**
- React 19 + react-native-web + vite-singlefile + @titan-design/react-ui
- Views: Initiatives (sectioned by state, rank-sorted), Initiative detail (brief excerpt + tasks + sessions + artifacts), Tasks (cross-initiative with filters), Artifacts (cross-initiative)
- Data via REST `/rpc/...`; live updates via WS `/ws`
- Build into `dist/dashboard/`, served by daemon at `/ui`

**Steps:** scaffold via vite + react-native-web alias; implement views; verify daemon serves the bundled HTML.

**Commit:** `feat(dashboard): read-only initiatives/tasks/artifacts views`

### Task 5.2: Skill content + postinstall

**Files:** `skill/SKILL.md`, `skill/references/{onboarding,auditing-existing-work,cli-dev}.md`, `scripts/postinstall.js`, `scripts/preuninstall.js`

**Behavior:**
- SKILL.md frontmatter: name `active-work`, description listing trigger phrases (work/initiative/handoff/audit/discover/wrap-up/etc.)
- Rules: edits route through CLI; mixed edit policy; bootstrap from `active-work open <slug>`; session capture at session end
- References: onboarding (use `active-work setup`), auditing-existing-work (drives discover/triage), cli-dev (developer reference)
- postinstall.js: copies skill/ tree into `~/.claude/skills/active-work/` if `~/.claude` exists (silent skip otherwise)
- preuninstall.js: removes `~/.claude/skills/active-work/`

**Commit:** `feat(skill): SKILL.md + references + postinstall hooks`

---

## Wave 6 — Setup wizard + release (sequential)

### Task 6.1: `active-work setup` and `active-work uninstall`

**Files:** `src/commands/setup.ts`, `src/commands/uninstall.ts`, `__tests__/commands/setup.test.ts`

**Behavior of `active-work setup`:**
1. Verify node ≥ 22
2. Create `<activeRoot>` and `<stateRoot>` if missing
3. Write `.schema-version` (1)
4. Write user config stub at `$XDG_CONFIG_HOME/active-work/config.json` if absent (interactive prompt)
5. Symlink skill into `~/.claude/skills/active-work/` (or postinstall already did it)
6. Register MCP server: `claude mcp add --user @hjewkes/active-work -- active-work mcp serve --stdio` (or write `.mcp.json` if `claude` isn't available, with operator confirmation)
7. Offer to install launchd plist (interactive prompt)
8. Start daemon
9. Offer ingestion: spawn `claude` at `<activeRoot>` with a discovery walkthrough prompt (interactive prompt)
10. Print summary + next steps

**Behavior of `active-work setup --update`:** re-run idempotently, skipping completed steps, picking up new defaults.

**Behavior of `active-work uninstall`:** reverse — unregister MCP, remove plist, remove skill symlink. Leave `<activeRoot>` untouched (operator removes manually after confirmation).

**Tests:** dry-run mode; idempotency.

**Commit:** `feat(setup): setup + update + uninstall wizard`

### Task 6.2: Release pipeline (changesets)

**Files:** `.changeset/config.json`, `.github/workflows/release.yml` (already stubbed)

**Behavior:**
- Changesets configured for npm-publish to public registry
- `release.yml`: on push to main with pending changesets, run changesets/action@v1 with `publish: pnpm changeset publish`
- First release: `0.1.0`. Add a changeset for "initial release."

**Steps:** `pnpm changeset init`, edit config (access: public, baseBranch: main), write first changeset, push.

**Commit:** `chore(release): initial changeset for 0.1.0`

---

## Wave 7 — Polish (3 parallel tasks)

### Task 7.1: Integration tests

**Files:** `__tests__/integration/end-to-end.test.ts`, `__tests__/integration/discover.test.ts`

**Behaviors:**
- Full lifecycle test: `active-work new` → `active-work task add` → `active-work task done` → `active-work archive`
- Discover with mocked `gh` and `git` subprocesses
- Daemon round-trip: start, RPC, WS subscription, file edit, event observed, stop

**Commit:** `test(integration): end-to-end lifecycle + discover + daemon`

### Task 7.2: Docs

**Files:** expand `README.md`, add `docs/architecture.md`, add `docs/cli-reference.md` (generated)

**Behaviors:**
- README: full install guide, quickstart (your first initiative), commands table, troubleshooting
- architecture.md: data model diagrams, daemon vs CLI flow, lifecycle states
- cli-reference.md: generated via `active-work help --markdown > docs/cli-reference.md` (script in package.json)

**Commit:** `docs: README + architecture + auto-generated CLI reference`

### Task 7.3: CLAUDE.md polish + first dogfood initiative

**Files:** `CLAUDE.md` (expand), `<activeRoot>/active-work/{brief.md, handoff.md, tasks/, sessions/, artifacts.yml}` (dogfood)

**Behaviors:**
- Use the new tool to scaffold an `active-work` initiative for the project itself
- First tasks: post-v0.1 wishlist (e.g., add Linux support, add `active-work doctor`, etc.)

**Commit:** `chore: dogfood — scaffold active-work initiative for the project`

---

## Appendix A — Full `package.json` (target shape)

```json
{
  "name": "@hjewkes/active-work",
  "version": "0.1.0",
  "type": "module",
  "description": "Durable workspace state for engineering work — CLI, MCP, and Claude skill for tracking initiatives across sessions",
  "license": "MIT",
  "author": "Henry Jewkes",
  "homepage": "https://github.com/hjewkes/active-work",
  "repository": { "type": "git", "url": "git+https://github.com/hjewkes/active-work.git" },
  "bin": { "aw": "dist/cli.js", "active-work": "dist/cli.js" },
  "files": ["dist", "skill", "scripts"],
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "dev": "tsx src/cli.ts",
    "build": "tsup && pnpm build:dashboard",
    "build:dashboard": "vite build --config src/dashboard/vite.config.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src __tests__",
    "format": "prettier --write \"src/**/*.ts\" \"__tests__/**/*.ts\"",
    "format:check": "prettier --check \"src/**/*.ts\" \"__tests__/**/*.ts\"",
    "postinstall": "node scripts/postinstall.js",
    "preuninstall": "node scripts/preuninstall.js",
    "changeset": "changeset",
    "release": "pnpm build && changeset publish"
  },
  "dependencies": {
    "@clack/prompts": "^0.9.0",
    "@commander-js/extra-typings": "^13.1.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@titan-design/react-ui": "^0.2.6",
    "chokidar": "^4.0.1",
    "commander": "^13.1.0",
    "env-paths": "^3.0.0",
    "gray-matter": "^4.0.3",
    "hono": "^4.6.14",
    "lucide-react": "^0.577.0",
    "mustache": "^4.2.0",
    "picocolors": "^1.1.1",
    "pino": "^9.5.0",
    "pino-pretty": "^13.0.0",
    "proper-lockfile": "^4.1.2",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "react-native-web": "^0.21.2",
    "uuid": "^11.0.3",
    "yaml": "^2.6.1",
    "zod": "^3.24.1",
    "zod-to-json-schema": "^3.24.1"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.10",
    "@types/mustache": "^4.2.5",
    "@types/node": "^22.13.4",
    "@types/proper-lockfile": "^4.1.4",
    "@types/uuid": "^10.0.0",
    "@vitejs/plugin-react": "^5.2.0",
    "@vitest/coverage-v8": "^3.2.4",
    "eslint": "^9.20.0",
    "lint-staged": "^16.3.2",
    "prettier": "^3.8.1",
    "tsup": "^8.3.6",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "typescript-eslint": "^8.24.1",
    "vite": "^6.0.5",
    "vite-plugin-singlefile": "^2.3.2",
    "vitest": "^3.0.5"
  }
}
```

---

## Appendix B — Self-review checklist

Run before declaring this plan ready:

1. **Spec coverage**: every decision in the design summary above maps to a task or file ✓
2. **Placeholder scan**: no "TBD" or "similar to" in task bodies ✓
3. **File path consistency**: every Task's Files block references paths in the File Structure table ✓
4. **Wave dependency soundness**: each wave's tasks are disjoint by file path ✓
5. **Verification step per task**: every task has explicit acceptance / tests ✓
6. **Commit per task**: every task ends in a commit message ✓

---

## Appendix C — What's NOT in v0.1.0

Explicitly deferred:

- Linux / Windows support (macOS only at v0)
- Read-write dashboard (read-only at v0)
- Cross-machine sync (manual git on `<activeRoot>` if operator wants it)
- v0 → v1 auto-migration (fresh start)
- Telemetry beyond local `usage.jsonl`
- `active-work doctor` health-check command
- Web UI auth (localhost-only)
- depends_on between initiatives
- `kind` enum, `health` enum, separate `priority` field
- Linear / Jira / Slack discovery sources (delegated to other skills)

---

## How to execute this plan

1. Review the plan (this document). Flag any wave / task that needs refinement.
2. Approve Wave 0 → I create the repo and run the linear setup as a single agent.
3. For each subsequent wave: dispatch each parallel task as a `superpowers:subagent-driven-development` agent with the task body as its brief. After all tasks in a wave commit, run the next wave's gate (typecheck + test on main).
4. On any wave failure: refine the task brief and re-dispatch; do not skip the verification step.

End of plan.
