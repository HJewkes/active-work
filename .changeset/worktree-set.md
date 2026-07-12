---
'@hjewkes/active-work': minor
---

AW-18: add `active-work worktree set <slug> <path> [--label <label>] [--default]`
to register or update a worktree on an existing initiative. Previously worktrees
could only be recorded at creation (`new --worktree`) or when tracking a discover
hit (`track --worktree`); there was no way to add one to an initiative that
already existed. The first worktree on an initiative becomes the default
automatically, updating a label that is already the default keeps it default,
and `--default` promotes an added worktree (clearing the flag on the others).
Pairs with cwd-based `open` resolution (AW-17) — registering a worktree is what
lets `aw` auto-open an initiative from its checkout directory.
