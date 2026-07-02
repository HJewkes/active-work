---
'@hjewkes/active-work': patch
---

AW-8: bootstrap now auto-archives stale done tasks. On `active-work open`, any
`done` task whose `done_at` is older than 30 days is moved from `tasks/<id>.yml`
to `tasks/archive/<id>.yml` — preserved and recoverable, but out of the active
list. Archived ids are surfaced as a short housekeeping note in the bootstrap
prompt. Best-effort: malformed or unmovable task files are left in place.
