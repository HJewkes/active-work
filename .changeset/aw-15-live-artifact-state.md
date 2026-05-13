---
'@hjewkes/active-work': minor
---

AW-15: simplify `artifacts.yml` to durable identifiers (`branches[]`,
`stashes[]`) and pull PR state live via `gh`. Bumps schema to v2 and
ships a v1 → v2 migrator that drops `prs[]` (with a per-file audit log
of dropped entries), removes `branches[].last_commit`, and renames
`stashes[].message` → `stashes[].label`.

- New: `artifact status <slug>` — live PR / git state, table or JSON.
- New: `artifact prune <slug> [--apply]` — drop branches that no
  longer exist locally (dry-run by default).
- New: `artifact note <slug> --repo X --name Y --note "..."` — set
  or update a branch note.
- Removed: `artifact add-pr` and `artifact check` (state is derived now).
- `artifact add-branch` gains `--note`; `--last-commit` is gone.
- `artifact add-stash` switches `--message` → `--label`, adds `--sha`,
  drops `--created`.
- `open` (bootstrap) live-pulls branch/PR state by default; pass
  `--offline` to render statically.
