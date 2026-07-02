---
'@hjewkes/active-work': minor
---

AW-5: `active-work sync` — multi-machine git sync for the active root. Runs
`git pull --rebase && git push` from inside the active root so a git-backed
workspace stays in step across machines.

- Auto-commits local edits first (the normal state — you just touched a task);
  `--message`/`-m` overrides the commit message, `--require-clean` fails instead
  of committing.
- Rebase conflicts are surfaced clearly (conflicted files + exact continue/abort
  commands) and left in place to resolve — never silently aborted. Local work is
  committed before the pull, so it's always safe.
- Guards with actionable errors: not a git repo, no upstream configured, or a
  detached HEAD.
- `rebased` is derived from whether HEAD actually moved, not from git's
  version-dependent "up to date" wording.
