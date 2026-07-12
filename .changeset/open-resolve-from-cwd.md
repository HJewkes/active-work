---
'@hjewkes/active-work': minor
---

AW-17: `aw` / `active-work open` now resolve the initiative from the current
directory when no slug is given. If the cwd sits inside an initiative's
registered worktree (`brief.md` → `worktrees[*].path`), that initiative is
bootstrapped directly; nested worktrees resolve to the deepest match. When the
cwd matches nothing — or two initiatives tie — it falls back to the interactive
picker as before. `open --pick` forces the picker, and `open --cwd <dir>` sets
the directory to resolve from (needed for callers like the daemon whose process
cwd isn't the user's shell). The result now carries `resolved_from: "slug" |
"cwd"` so callers can explain the auto-open.
