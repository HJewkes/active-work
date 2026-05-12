# active-work

Durable workspace state for engineering work — CLI, MCP, and Claude skill for tracking initiatives across sessions.

## Status

Pre-alpha. Active development in waves; see [`docs/superpowers/plans/`](./docs/superpowers/plans/).

## Install

Coming soon. Will be published as `@hjewkes/active-work`.

```bash
npm install -g @hjewkes/active-work
aw setup
```

## Quickstart

```bash
aw new my-initiative --title "My Initiative" --ship-target 2026-Q3
aw task add my-initiative --title "First task" --priority 1
aw-work my-initiative   # bootstraps a Claude session
```

## Architecture

- **CLI** (`aw`) — non-interactive primitives for managing initiatives
- **MCP server** — Claude Code talks to the same primitives via Model Context Protocol
- **Daemon** (`aw mcp serve`) — long-running process exposing HTTP, WebSocket, MCP, and a web dashboard at `http://127.0.0.1:7400`
- **Skill** — `~/.claude/skills/active-work/SKILL.md` provides Claude with trigger phrases and rules
- **Data** — plain files under `$XDG_DATA_HOME/active-work/<slug>/`

See [`docs/superpowers/plans/2026-05-12-active-work-v2.md`](./docs/superpowers/plans/2026-05-12-active-work-v2.md) for the full design.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Node 22+ and pnpm required.

## License

MIT
