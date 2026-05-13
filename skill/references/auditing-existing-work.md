# Auditing existing work — discover + triage

If the user has a pile of in-flight work but nothing tracked in `active-work` (or only partially tracked), this walkthrough drives them through discovery and triage in three categories: **Track**, **Fold**, **Drop**.

## When to use

- "I have a bunch of stuff in flight and I want to get it all into active-work"
- "audit my workstreams"
- "find untracked work"
- "what am I forgetting"
- After a long break — sync state with reality before continuing

## 1. Discover

`active-work discover` walks the configured discovery sources and returns candidate references (PRs, branches, local repos, recent Claude sessions, project directories). Sources are configured in the user's `$XDG_CONFIG_HOME/active-work/config.json` under `discovery`:

```json
{
  "discovery": {
    "githubRepos": ["hjewkes/active-work", "hjewkes/brain"],
    "localRepos": ["~/Documents/projects/active-work", "~/Documents/projects/brain"],
    "projectsRoot": "~/Documents/projects"
  }
}
```

Run:

```bash
active-work discover
```

Output lists each hit with a stable `ref` (e.g. `gh:hjewkes/active-work#42`, `git:active-work@feat/dashboard`, `dir:/Users/h/projects/foo`, `claude:session/abc123`), a short title, and a guess at the freshest activity date.

## 2. Triage each hit

For every reference, decide one of three actions:

### Track — it's a real initiative

If the work is meaningful and ongoing, give it a slug and a title:

```bash
active-work track gh:hjewkes/active-work#42 \
  --slug dashboard-perf \
  --title "Dashboard load is sluggish on cold open"
```

`active-work track` scaffolds the initiative (`brief.md` with frontmatter, empty `handoff.md`, empty `tasks/`, an `artifacts.yml` seeded with the source ref), then prints the new slug. Open it next:

```bash
active-work open dashboard-perf
```

### Fold — it belongs under something you already track

If the ref is part of an initiative you already have (e.g. one of three PRs against the same effort), fold it in as an artifact:

```bash
active-work fold gh:hjewkes/active-work#43 \
  --into dashboard-perf \
  --note "follow-up PR for the WS reconnection fix"
```

This appends to `artifacts.yml` and writes a row in `sources/discovery.yml` so the same ref won't reappear on the next `active-work discover`.

### Drop — not real / not yours / abandoned

Mark it dismissed so future `active-work discover` runs ignore it:

```bash
active-work drop gh:upstream/repo#99 --reason "upstream issue, not actionable"
```

The ref is recorded in `sources/discovery.yml` with `dismissed: true` and the reason. You can resurrect it with `active-work track <ref>` later if you change your mind.

## 3. Verify state

After triage, run the audit to catch issues:

```bash
active-work audit
```

Audit checks:

- Every active slug has a non-empty `handoff.md`
- Every active slug has at least one open task (otherwise: should it be archived?)
- `artifacts.yml` references resolve (PRs exist, branches exist locally, etc.)
- Last session timestamp isn't stale beyond the configured threshold
- No frontmatter validation errors

Warnings are non-fatal. Fix them iteratively with `active-work set <slug> ...`, `active-work task add`, or `active-work archive`.

## Worked example

```text
$ active-work discover
gh:hjewkes/active-work#42       Dashboard cold-load perf            2d ago
gh:hjewkes/active-work#43       Fix WS reconnect after sleep        2d ago
git:brain@feat/inbox-rewrite    feat/inbox-rewrite (4 commits)      5d ago
dir:~/projects/scratch-jq       scratch-jq                          11d ago
claude:session/0192abc          "look at this gnarly stack trace"   23d ago

$ active-work track gh:hjewkes/active-work#42 --slug dashboard-perf --title "Dashboard cold-load perf"
created: dashboard-perf

$ active-work fold gh:hjewkes/active-work#43 --into dashboard-perf --note "WS reconnect follow-up"
folded into dashboard-perf

$ active-work track git:brain@feat/inbox-rewrite --slug brain-inbox-rewrite --title "Brain inbox rewrite"
created: brain-inbox-rewrite

$ active-work drop dir:~/projects/scratch-jq --reason "scratch repo, not real work"
dropped

$ active-work drop claude:session/0192abc --reason "one-off debugging, no follow-up"
dropped

$ active-work audit
brain-inbox-rewrite: handoff.md is empty — add a one-paragraph status
ok: 1 warning across 2 initiatives
```

The user is now caught up. Continue with `active-work open dashboard-perf` (or whichever slug they want to push on first).
