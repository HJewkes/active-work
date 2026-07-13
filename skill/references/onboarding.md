# Onboarding — first-time `active-work` setup

This walkthrough takes a brand-new machine to a working `active-work` install with the Claude Code skill available.

## 1. Verify prerequisites

`active-work` requires Node 22 or newer. `pnpm` is recommended for global installs because it manages multiple Node versions cleanly, but `npm` works too.

```bash
node --version   # expect v22.x or newer
pnpm --version   # any recent version, e.g. 9.x or 10.x
```

If Node is older than 22, install a current LTS via `nvm`, `fnm`, or `volta` before continuing.

## 2. Install the package globally

```bash
npm install -g @titan-design/active-work
# or
pnpm add -g @titan-design/active-work
```

The package ships the CLI binary (`active-work`), a thin Claude-session launcher (`aw <slug>`), the MCP server, the dashboard bundle, and the Claude skill content.

## 3. Postinstall hook copies the skill

On install, `scripts/postinstall.js` runs automatically. It looks for `~/.claude/` and, if present, copies the bundled `skill/` directory into `~/.claude/skills/active-work/`. If `~/.claude/` does not exist (Claude Code not installed), the hook exits silently so the npm install never fails.

You can verify the skill landed:

```bash
ls ~/.claude/skills/active-work/
# expect: SKILL.md  references/
```

## 4. Run `active-work setup`

`active-work setup` (Wave 6) is the interactive wizard that initializes data roots, registers the MCP server with Claude Code, and offers to install the daemon launchd plist. **It is not yet implemented.** Until it lands, you can prepare the data root manually:

```bash
mkdir -p "${XDG_DATA_HOME:-$HOME/Library/Application Support}/active-work"
```

(On Linux this resolves to `~/.local/share/active-work/`; on macOS to `~/Library/Application Support/active-work/`.)

Register the MCP server with Claude Code manually for now:

```bash
claude mcp add --user @hjewkes/active-work -- active-work mcp serve --stdio
```

## 5. Verify the install

```bash
active-work --help          # prints the command surface
active-work mcp status      # reports daemon state
```

`active-work mcp status` will report "not running" until you start the daemon (next step).

## 6. Optional — start the daemon

The daemon hosts MCP-over-HTTP, the REST API, the WebSocket live feed, and the dashboard.

```bash
active-work mcp serve --detach
```

Then visit `http://127.0.0.1:7400/ui` to see the dashboard. Stop it with `active-work mcp stop`.

You're done. Open Claude Code in any directory and ask "what am I working on?" — the `active-work` skill should engage and surface your initiatives.
