# The egress scan

active-work is public, so a branch is public the moment it is pushed. `@titan-design/egress-scan`
(its README has the rules and the command line) checks what a push sends for absolute home paths,
paths into the active-work data directory and terms from a private list. A finding names a
location and a rule id and never the matched text. Adopted by CC-443.

## The pre-push hook

`pnpm install` runs `prepare`, which runs `titan-egress-scan install-hook`. The hook goes into
`git rev-parse --git-path hooks`, which for a linked worktree is the shared `.git/hooks` of the main
checkout, so one install covers every checkout. The installer never replaces a `pre-push` it did not
write; it prints a chaining hint instead, and `prepare` still succeeds. The hook is the control; the
CI job below is a merge gate behind it.

The private term list lives at `$XDG_CONFIG_HOME/titan-egress/private-terms` (default
`~/.config/titan-egress/private-terms`). When it is missing, the hook scans with the generic rules
only.

## The allow file

`.egress-allow` holds `<glob> <rule-id> <reason>` lines, one per file and rule, and each reason names
a task id. The entries cover docs that name the data dir on purpose and tests that use a placeholder
home. Code that needs the data dir builds it with `path.join` or `env-paths`, so it never matches.
`private-term` hits are never allowable.

## The CI job

The `egress-scan` job runs `npx --yes @titan-design/egress-scan@<exact version> range` over the pull
request's base and head shas, with no install or build step. It scans the PR head, not GitHub's merge
ref. CI has no term list, so it checks the generic rules only. The version in `ci.yml` is pinned;
bump it with the `devDependencies` range.
