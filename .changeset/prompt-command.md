---
'@hjewkes/active-work': minor
---

AW-19: add `active-work prompt [slug]` and a bundled `/aw-prompt` Claude Code
slash command for re-seeding context inside a running session.

`prompt` prints the same bootstrap text `aw` feeds Claude at launch (brief,
handoff, latest session, open tasks, artifacts) — resolved from a slug or the
caller's cwd — but as **plain text** and with **no side effects** (unlike
`open`, it never auto-archives stale tasks). In `--json` mode it's returned in
the envelope as a string. A bare string command result now prints raw in human
mode instead of JSON-wrapped.

The `/aw-prompt` slash command wraps it: it runs `active-work prompt` and injects
the output as session context. It installs to `~/.claude/commands/aw-prompt.md`
via the same paths as the skill — `postinstall` and the `active-work setup`
wizard — and `active-work uninstall` removes it. The cwd-resolution helpers
(`resolveSlug`, `resolveSlugFromCwd`) were extracted from `open` into a shared
module so both commands stay in lockstep.
