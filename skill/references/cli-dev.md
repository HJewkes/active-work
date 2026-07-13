# CLI dev — internal architecture for skill maintainers

If you are modifying the `active-work` skill, adding a CLI command, extending the daemon, or wiring a new MCP tool, this is the orientation doc. The CLI source lives in `hjewkes/active-work`.

## Directory map

| Path | What's here |
|---|---|
| `src/cli.ts` | Entrypoint. Wires commander to the command registry. |
| `src/registry/` | Command registry types, JSON envelope, dispatcher contract. The single source of truth for both CLI and MCP. |
| `src/commands/` | One file per CLI command; each exports a `defineCommand({...})` entry. |
| `src/commands/index.ts` | The aggregate export — register a new command here. |
| `src/schemas/` | Zod schemas for `brief.md` frontmatter, tasks, sessions, artifacts, state. Every write goes through a validator. |
| `src/utils/` | `fs-atomic` (atomic writes + flock), `paths`, `slug`, `gray-matter-io`, `yaml-io`, `today`, `color`. |
| `src/server/` | hono HTTP + WS + MCP-over-HTTP daemon. |
| `src/dashboard/` | React (react-native-web) read-only dashboard; built via vite. |
| `src/migrations/` | Schema migrations keyed by `from` version. |
| `src/lint/` | Per-artifact lint rules (warn-only). |
| `src/templates/` | Mustache templates for scaffolding new initiatives. |
| `src/bootstrap/` | Bootstrap prompt assembly used by `active-work open`. |
| `src/discover/` | Discovery sources (gh, git, projects, Claude sessions). |
| `skill/` | This skill. Copied into `~/.claude/skills/active-work/` by `scripts/postinstall.js`. |
| `scripts/` | npm lifecycle hooks: `postinstall.js`, `preuninstall.js`. |
| `__tests__/` | Vitest tests; fixtures under `__tests__/fixtures/`. |

## Adding a new command

1. Create `src/commands/<name>.ts` exporting a `defineCommand({...})` entry. Define:
   - `name` (e.g. `"task add"`)
   - `description`
   - `input` zod schema
   - `output` zod schema
   - `handler(input, ctx)` returning the validated output
2. Add the import + registration in `src/commands/index.ts`.
3. The CLI dispatcher and MCP server both pick it up automatically — do not hand-maintain MCP tool definitions.
4. Add a test under `__tests__/commands/<name>.test.ts`. Use `withTempActiveRoot` / `withEmptyActiveRoot` helpers from `__tests__/setup/test-helpers.ts` for filesystem isolation.

## Schema + write discipline

- Every write to `brief.md` frontmatter, `tasks/*.yml`, `sessions/*.md` (frontmatter), or `artifacts.yml` must go through a validator in `src/schemas/`.
- Read-modify-write must use `withFileLock` from `src/utils/fs-atomic.ts` to take a per-initiative POSIX flock.
- Paths are computed via `env-paths` through `src/utils/paths.ts`. Never hardcode `~/.local/share/...`.

## Daemon

`src/server/` runs hono on `127.0.0.1:7400` by default (override with `AW_PORT`). It serves:

- `/rpc/<command>` — REST for every registry entry
- `/ws` — WebSocket live feed (chokidar-backed filesystem events)
- `/mcp` — MCP-over-HTTP transport
- `/ui` — bundled dashboard SPA

The same daemon process can also speak MCP-over-stdio when invoked as `active-work mcp serve --stdio`.

## Skill content

This skill is just three files: `SKILL.md` and three references. Keep `SKILL.md` skim-able (target ~150 lines, hard cap ~200). Push depth into references and link from `SKILL.md`. The frontmatter `description` is what Claude Code uses to decide whether to load the skill, so keep trigger phrases there fresh and aligned with the CLI command surface.

When you add a trigger phrase to `SKILL.md`, ask: is there an existing CLI command that handles it? If not, add the command first, then the trigger.

## Release flow

Changes to skill content ship in the next `@titan-design/active-work` release. The `postinstall.js` hook reinstalls the skill on every update; users do not need to do anything beyond `npm install -g @titan-design/active-work@latest` (or the pnpm equivalent).
