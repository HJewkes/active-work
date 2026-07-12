---
'@hjewkes/active-work': minor
---

AW-17: `aw` / `active-work open` now resolve the initiative from the current
directory when no slug is given. If the cwd sits inside an initiative's
registered worktree (`brief.md` → `worktrees[*].path`), that initiative is
bootstrapped directly; nested worktrees resolve to the deepest match. When the
cwd matches nothing — or two initiatives tie — it falls back to the interactive
picker as before. When resolved this way, the session launches in the matched
worktree the user was standing in — not the brief's default worktree — and
paths are canonicalized so symlinked checkouts still match.

`aw --pick` / `open --pick` force the picker, and `open --cwd <dir>` sets the
directory to resolve from. The cwd comes from the interactive surface (CLI /
`aw`); daemon and MCP callers, whose process cwd isn't the user's shell, must
pass `cwd` explicitly to opt in — otherwise they still get the picker. The
result now carries `resolved_from: "slug" | "cwd"` so callers can explain the
auto-open.
