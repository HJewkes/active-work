# CLI reference

Generated from `active-work --help` and individual command `--help` outputs.
Re-run `node scripts/gen-cli-reference.mjs` to refresh after the CLI
surface changes.

## active-work

Top-level help. Run `active-work <command> --help` for command-specific options.

```
Usage: active-work [options] [command]

active-work CLI — durable workspace state for engineering work

Options:
  -V, --version                 output the version number
  --json                        emit machine-readable JSON envelope on stdout
  -h, --help                    display help for command

Commands:
  archive <slug> <domain>       Move an initiative out of active root into
                                <archiveRoot>/<domain>/archive/.
  artifact                      artifact commands
  audit                         Cross-initiative summary: lists every
                                initiative, parse failures, and worktree path
                                conflicts.
  context                       context commands
  discover [options]            Scan configured sources (gh PRs, local git,
                                projects root, Claude sessions) and emit
                                unfiltered discovery hits.
  doctor                        Health-check the install: Node, active root,
                                daemon, MCP registration, skill, and
                                supervision.
  drop [options] <ref>          Mark a discover hit as dropped so future
                                discovers suppress it.
  edit <slug> <target>          Open the operator's editor on brief.md.
  focus [options] <slug>        Promote an initiative into the focused list at a
                                given rank.
  fold [options] <ref>          Mark a discover hit as folded into an existing
                                initiative.
  list                          List every initiative grouped by state. Replaces
                                the legacy INDEX.md dump.
  loops [options] <slug>        List an initiative's open-loop ledger. Open
                                loops are the unresolved remainder; resolved
                                ones carry the outcome and the reason they were
                                closed, which the bootstrap only surfaces for
                                recent abandonments.
  mcp                           mcp commands
  migrate [options]             Preview (or apply) the pending v2→v3 open-loops
                                migration.
  miner                         miner commands
  new [options] <slug>          Scaffold a new initiative directory.
  note                          note commands
  open [options] [slug]         Bootstrap a Claude session for an initiative.
                                Without a slug, resolves the initiative whose
                                worktree contains the caller's cwd; falls back
                                to the picker list when nothing matches.
  paths <slug>                  Print all artifact paths for an initiative.
  pause [options] <slug>        Mark an initiative as paused with required
                                restart metadata.
  preflight [options] <slug>    Read-only pre-wrap sweep: the uncommitted trees,
                                unpushed branches, and
                                worktrees/branches/stashes present in git but
                                missing from artifacts.yml, plus the checklist a
                                wrap must answer. Writes nothing.
  prompt [options] [slug]       Print the bootstrap prompt for an initiative —
                                the same text `aw` feeds Claude at launch —
                                without any side effects. Resolves the
                                initiative from a slug or the caller's cwd. Use
                                it to re-seed context in a running session.
  rename <old_slug> <new_slug>  Rename an initiative slug (moves the directory;
                                task_prefix unchanged).
  session                       session commands
  sessions [options]            Browse recent Claude sessions discovered under
                                ~/.claude/projects.
  set <slug> <field> <value>    Set a single field on an initiative brief.md
                                frontmatter.
  setup [options]               Interactive wizard: verifies Node, scaffolds
                                directories, registers the MCP server, and
                                optionally starts the daemon and walks through
                                ingestion.
  source                        source commands
  sync [options]                Sync the active root over git: auto-commit local
                                edits, pull --rebase, then push.
  task                          task commands
  touch <slug>                  Stamp `updated: today()` on an initiative's
                                brief.md.
  track [options] <ref>         Scaffold a new initiative from a discover hit.
  unfocus <slug>                Demote a focused initiative to backburner and
                                renumber survivors.
  uninstall [options]           Reverse what setup did: remove the skill, stop
                                the daemon, unregister MCP. Preserves the active
                                root.
  unpause <slug>                Move a paused initiative back to backburner.
  worktree                      worktree commands
  wrap [options] <slug>         The last thing a session does. Treat it as the
                                moment the process exits: everything not
                                persisted before wrap returns is lost, so file
                                it first and wrap last. Every category the
                                session can leave behind needs an explicit
                                answer, and omitting one is an error rather than
                                a default — open loops (--next-steps /
                                --resolves, or --no-loops), durable notes
                                (--notes or --no-notes), and tasks created this
                                session (--tasks-filed or --no-tasks). Writes
                                the session file and its ledger, files the notes
                                under sources/notes/, records any worktrees,
                                branches and stashes the initiative had not
                                written down, stamps the brief's updated date,
                                and returns a receipt of what was filed.
  help [command]                display help for command

Run `active-work <command> --help` for command-specific options.
Tip: `aw [slug]` launches Claude with the bootstrap prompt.
```

## active-work archive

```
Usage: active-work archive [options] <slug> <domain>

Move an initiative out of active root into <archiveRoot>/<domain>/archive/.

Arguments:
  slug        slug (string)
  domain      domain (string)

Options:
  -h, --help  display help for command
```

## active-work artifact add-branch

```
Usage: active-work artifact add-branch [options] <slug>

Append or upsert a branch entry in artifacts.yml.

Arguments:
  slug            slug (string)

Options:
  --repo <value>  Repo path or org/repo
  --name <value>  Branch name
  --note <value>  Why this branch is worth tracking
  -h, --help      display help for command
```

## active-work artifact add-stash

```
Usage: active-work artifact add-stash [options] <slug>

Append a stash entry to artifacts.yml.

Arguments:
  slug             slug (string)

Options:
  --repo <value>   Repo path
  --label <value>  Stash label
  --sha <value>    Stash SHA, if known
  -h, --help       display help for command
```

## active-work artifact list

```
Usage: active-work artifact list [options] [slug]

List artifacts for a slug or across all initiatives.

Arguments:
  slug               slug (string)

Options:
  --all-initiatives  Return artifacts for every initiative
  -h, --help         display help for command
```

## active-work artifact note

```
Usage: active-work artifact note [options] <slug>

Set or update the free-form note on a tracked branch.

Arguments:
  slug            slug (string)

Options:
  --repo <value>  Repo path or org/repo
  --name <value>  Branch name
  --note <value>  Note text
  -h, --help      display help for command
```

## active-work artifact prune

```
Usage: active-work artifact prune [options] <slug>

List (default) or remove (--apply) tracked branches that no longer exist
locally.

Arguments:
  slug        slug (string)

Options:
  --apply     Write the pruned artifacts.yml. Without this, dry-run only.
  -h, --help  display help for command
```

## active-work artifact status

```
Usage: active-work artifact status [options] <slug>

Pull live PR and branch state for the initiative via `git` + `gh`. Read-only.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## active-work audit

```
Usage: active-work audit [options]

Cross-initiative summary: lists every initiative, parse failures, and worktree
path conflicts.

Options:
  -h, --help  display help for command
```

## active-work context graph

```
Usage: active-work context graph [options] <id>

Trace every exact-ID reference to a task id, session, or loop ref across tasks,
sessions, and artifacts

Arguments:
  id              id (string)

Options:
  --slug <value>  Limit the scan to one initiative (default: every initiative)
  -h, --help      display help for command
```

## active-work discover

```
Usage: active-work discover [options]

Scan configured sources (gh PRs, local git, projects root, Claude sessions) and
emit unfiltered discovery hits.

Options:
  --github-repos <value>   Comma-separated owner/repo list for gh PR discovery
  --local-repos <value>    Comma-separated repo paths for local git discovery
  --projects-root <value>  Root directory whose subdirs are scanned as projects
  -h, --help               display help for command
```

## active-work doctor

```
Usage: active-work doctor [options]

Health-check the install: Node, active root, daemon, MCP registration, skill,
and supervision.

Options:
  -h, --help  display help for command
```

## active-work drop

```
Usage: active-work drop [options] <ref>

Mark a discover hit as dropped so future discovers suppress it.

Arguments:
  ref               ref (string)

Options:
  --reason <value>  Optional one-line reason recorded in the triage log
  -h, --help        display help for command
```

## active-work edit

```
Usage: active-work edit [options] <slug> <target>

Open the operator's editor on brief.md.

Arguments:
  slug        slug (string)
  target      target (enum)

Options:
  -h, --help  display help for command
```

## active-work focus

```
Usage: active-work focus [options] <slug>

Promote an initiative into the focused list at a given rank.

Arguments:
  slug            slug (string)

Options:
  --rank <value>  Target rank (positive integer). Defaults to end of list.
  -h, --help      display help for command
```

## active-work fold

```
Usage: active-work fold [options] <ref>

Mark a discover hit as folded into an existing initiative.

Arguments:
  ref             ref (string)

Options:
  --into <value>  Slug of the initiative this hit is folded into
  --note <value>  Optional human note describing the fold
  -h, --help      display help for command
```

## active-work list

```
Usage: active-work list [options]

List every initiative grouped by state. Replaces the legacy INDEX.md dump.

Options:
  -h, --help  display help for command
```

## active-work loops

```
Usage: active-work loops [options] <slug>

List an initiative's open-loop ledger. Open loops are the unresolved remainder;
resolved ones carry the outcome and the reason they were closed, which the
bootstrap only surfaces for recent abandonments.

Arguments:
  slug             slug (string)

Options:
  --state <value>  'open' (default) | 'resolved' | 'abandoned' | 'all'
  -h, --help       display help for command
```

## active-work mcp logs

```
Usage: active-work mcp logs [options]

Return the last N lines of the daemon log (default 50).

Options:
  --lines <value>  Number of trailing lines to return (default 50).
  -h, --help       display help for command
```

## active-work mcp restart

```
Usage: active-work mcp restart [options]

Restart the MCP HTTP daemon (stop, then spawn a fresh detached instance).

Options:
  --port <value>  Port for the restarted daemon (default: previous port or
                  7400).
  -h, --help      display help for command
```

## active-work mcp serve

```
Usage: active-work mcp serve [options]

Start the MCP server. --stdio for stdio mode; --detach to fork the HTTP daemon;
otherwise runs the HTTP daemon in the foreground.

Options:
  --stdio         Run in stdio mode for Claude Code `claude mcp add`.
  --detach        Spawn the HTTP daemon in the background and return.
  --port <value>  TCP port for the HTTP daemon (default 7400).
  -h, --help      display help for command
```

## active-work mcp status

```
Usage: active-work mcp status [options]

Report the MCP HTTP daemon status (pid, port, version, uptime).

Options:
  -h, --help  display help for command
```

## active-work mcp stop

```
Usage: active-work mcp stop [options]

Stop the running MCP HTTP daemon (sends SIGTERM, waits for exit).

Options:
  -h, --help  display help for command
```

## active-work migrate

```
Usage: active-work migrate [options]

Preview (or apply) the pending v2→v3 open-loops migration.

Options:
  --dry-run   Report what would change; write nothing
  --apply     Actually run the migration
  -h, --help  display help for command
```

## active-work miner drain-ingest

```
Usage: active-work miner drain-ingest [options]

Cluster new tool-result/error blobs from Claude transcripts into the template
store.

Options:
  --full           Ignore stored watermarks and re-read every transcript from
                   byte 0.
  --limit <value>  Visit at most N transcripts.
  --verify-hashes  Re-hash each read prefix to detect a rewritten transcript
                   (slow).
  -h, --help       display help for command
```

## active-work miner refresh

```
Usage: active-work miner refresh [options]

Index new Claude session transcripts into the session-signal index.

Options:
  --full           Drop every derived row and re-read all transcripts from byte
                   0.
  --limit <value>  Visit at most N transcripts.
  --verify-hashes  Re-hash every transcript to detect source drift (slow;
                   implied by --full).
  -h, --help       display help for command
```

## active-work miner status

```
Usage: active-work miner status [options]

Report session-signal index size, freshness, and daemon indexing state.

Options:
  -h, --help  display help for command
```

## active-work new

```
Usage: active-work new [options] <slug>

Scaffold a new initiative directory.

Arguments:
  slug                   slug (string)

Options:
  --title <value>        Initiative title
  --ship-target <value>  Ship target (e.g., 2026-Q3)
  --owner <value>        Owner / handle
  --worktree <value>     Default worktree path
  -h, --help             display help for command
```

## active-work note add

```
Usage: active-work note add [options] <slug>

File a durable note under <slug>/sources/notes/ — a process lesson, gotcha,
decision, or FYI that a future session needs but that no task would carry.
Actionable work belongs in `task add` instead.

Arguments:
  slug                 slug (string)

Options:
  --kind <value>       process | gotcha | fyi | decision
  --title <value>      Short title, at most 120 chars (slugified into the
                       filename)
  --body <value>       Raw markdown body
  --body-file <value>  Path to a file containing the markdown body
  --tags <value>       Comma-separated tags
  -h, --help           display help for command
```

## active-work note list

```
Usage: active-work note list [options] <slug>

List durable notes for an initiative, newest first.

Arguments:
  slug            slug (string)

Options:
  --kind <value>  Only notes of this kind: process | gotcha | fyi | decision
  -h, --help      display help for command
```

## active-work open

```
Usage: active-work open [options] [slug]

Bootstrap a Claude session for an initiative. Without a slug, resolves the
initiative whose worktree contains the caller's cwd; falls back to the picker
list when nothing matches.

Arguments:
  slug                slug (string)

Options:
  --offline           Skip the live `gh`/`git` artifact lookup; render artifacts
                      statically.
  --cwd <value>       Directory to resolve the initiative from when no slug is
                      given (default: current directory).
  --pick              Always return the picker list; skip resolving the
                      initiative from the current directory.
  --adhoc             Frame the prompt as ad-hoc work on the workstream
                      (awaiting the user’s task), not a continuation of the
                      handoff / top task.
  --no-sibling-check  Skip the check for another session already live on this
                      initiative, and do not record a lease for this one.
  -h, --help          display help for command
```

## active-work paths

```
Usage: active-work paths [options] <slug>

Print all artifact paths for an initiative.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## active-work pause

```
Usage: active-work pause [options] <slug>

Mark an initiative as paused with required restart metadata.

Arguments:
  slug                       slug (string)

Options:
  --since <value>            Pause-since date (YYYY-MM-DD).
  --restart-trigger <value>  What event should cause this initiative to resume.
  -h, --help                 display help for command
```

## active-work preflight

```
Usage: active-work preflight [options] <slug>

Read-only pre-wrap sweep: the uncommitted trees, unpushed branches, and
worktrees/branches/stashes present in git but missing from artifacts.yml, plus
the checklist a wrap must answer. Writes nothing.

Arguments:
  slug           slug (string)

Options:
  --cwd <value>  Directory to include in the swept repo set (default: current
                 directory).
  -h, --help     display help for command
```

## active-work prompt

```
Usage: active-work prompt [options] [slug]

Print the bootstrap prompt for an initiative — the same text `aw` feeds Claude
at launch — without any side effects. Resolves the initiative from a slug or the
caller's cwd. Use it to re-seed context in a running session.

Arguments:
  slug                slug (string)

Options:
  --offline           Skip the live `gh`/`git` artifact lookup; render artifacts
                      statically.
  --cwd <value>       Directory to resolve the initiative from when no slug is
                      given (default: current directory).
  --adhoc             Frame the prompt as ad-hoc work on the workstream,
                      awaiting the user’s task, not a continuation of the
                      handoff / top task.
  --no-sibling-check  Skip the check for another session already live on this
                      initiative.
  -h, --help          display help for command
```

## active-work rename

```
Usage: active-work rename [options] <old_slug> <new_slug>

Rename an initiative slug (moves the directory; task_prefix unchanged).

Arguments:
  old_slug    old_slug (string)
  new_slug    new_slug (string)

Options:
  -h, --help  display help for command
```

## active-work session list

```
Usage: active-work session list [options] <slug>

List session summaries for an initiative, sorted by end time

Arguments:
  slug             slug (string)

Options:
  --limit <value>  Maximum sessions to return (default 100)
  -h, --help       display help for command
```

## active-work sessions

```
Usage: active-work sessions [options]

Browse recent Claude sessions discovered under ~/.claude/projects.

Options:
  --limit <value>   Max sessions to return (default 50).
  --include-active  Include sessions whose cwd lives under an active initiative.
  -h, --help        display help for command
```

## active-work set

```
Usage: active-work set [options] <slug> <field> <value>

Set a single field on an initiative brief.md frontmatter.

Arguments:
  slug        slug (string)
  field       field (string)
  value       value (unknown)

Options:
  -h, --help  display help for command
```

## active-work setup

```
Usage: active-work setup [options]

Interactive wizard: verifies Node, scaffolds directories, registers the MCP
server, and optionally starts the daemon and walks through ingestion.

Options:
  --update    Re-run setup idempotently (may overwrite the config stub).
  -y, --yes   Skip all prompts; use defaults (no daemon, no ingestion).
  -h, --help  display help for command
```

## active-work source add

```
Usage: active-work source add [options] <slug> <file>

Move a source file into <slug>/sources/ with a conventional filename.

Arguments:
  slug                 slug (string)
  file                 file (string)

Options:
  --type <value>       Source type: pr | deepdive | session | pointer
  --label <value>      Short label (slugified into filename)
  --topic <value>      Topic for deepdive type
  --pr-number <value>  PR number for type=pr
  --date <value>       Date YYYY-MM-DD for type=session
  --force              Overwrite if target exists
  -h, --help           display help for command
```

## active-work source list

```
Usage: active-work source list [options] <slug>

List an initiative's sources, derived by reading sources/*.md — never a stored
index.

Arguments:
  slug            slug (string)

Options:
  --type <value>  Only sources of this type: pr | deepdive | session | pointer
  -h, --help      display help for command
```

## active-work sync

```
Usage: active-work sync [options]

Sync the active root over git: auto-commit local edits, pull --rebase, then
push.

Options:
  -m, --message <value>  Commit message for the auto-commit (default: timestamp
                         + host)
  --require-clean        Fail instead of auto-committing when the tree is dirty
  -h, --help             display help for command
```

## active-work task add

```
Usage: active-work task add [options] <slug>

Create a new task in an initiative

Arguments:
  slug                 slug (string)

Options:
  --title <value>      Task title
  --priority <value>   Priority (positive int)
  --severity <value>   critical|high|medium|low
  --estimate <value>   Estimate (hours)
  --done-when <value>  Definition of done
  --tags <value>       Comma-separated tag list
  --notes <value>      Free-form notes
  -h, --help           display help for command
```

## active-work task delete

```
Usage: active-work task delete [options] <slug> <id>

Hard delete a task file (prefer task.done in normal use)

Arguments:
  slug        slug (string)
  id          id (string)

Options:
  -h, --help  display help for command
```

## active-work task done

```
Usage: active-work task done [options] <slug> <id>

Mark a task as done

Arguments:
  slug        slug (string)
  id          id (string)

Options:
  -h, --help  display help for command
```

## active-work task edit

```
Usage: active-work task edit [options] <slug> <id> <field> <value>

Edit a single field on a task

Arguments:
  slug        slug (string)
  id          id (string)
  field       field (string)
  value       value (unknown)

Options:
  -h, --help  display help for command
```

## active-work task list

```
Usage: active-work task list [options] [slug]

List tasks for an initiative or across all initiatives

Arguments:
  slug                slug (string)

Options:
  --all-initiatives   Scan every initiative under the active root
  --tag <value>       Filter by tag membership
  --severity <value>  Filter by severity (critical|high|medium|low)
  --status <value>    open (default), done, or all
  -h, --help          display help for command
```

## active-work task reorder

```
Usage: active-work task reorder [options] <slug> <id> <new_priority>

Move a task to a new priority and shift siblings down

Arguments:
  slug          slug (string)
  id            id (string)
  new_priority  new_priority (number)

Options:
  -h, --help    display help for command
```

## active-work touch

```
Usage: active-work touch [options] <slug>

Stamp `updated: today()` on an initiative's brief.md.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## active-work track

```
Usage: active-work track [options] <ref>

Scaffold a new initiative from a discover hit.

Arguments:
  ref                    ref (string)

Options:
  --slug <value>         Kebab-case slug for the new initiative
  --title <value>        Human-readable initiative title
  --ship-target <value>  Target ship window (e.g. 2026-Q3)
  --owner <value>        Initiative owner handle
  --worktree <value>     Default worktree path to record on the brief
  -h, --help             display help for command
```

## active-work unfocus

```
Usage: active-work unfocus [options] <slug>

Demote a focused initiative to backburner and renumber survivors.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## active-work uninstall

```
Usage: active-work uninstall [options]

Reverse what setup did: remove the skill, stop the daemon, unregister MCP.
Preserves the active root.

Options:
  -y, --yes   Skip all prompts; assume yes.
  -h, --help  display help for command
```

## active-work unpause

```
Usage: active-work unpause [options] <slug>

Move a paused initiative back to backburner.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## active-work worktree set

```
Usage: active-work worktree set [options] <slug> <path>

Add or update a registered worktree on an existing initiative. A lone worktree
is made default automatically; use --default to promote an added one. Registered
worktrees live in artifacts.yml alongside the ones wrap sweeps, and are what
`aw` resolves a cwd against.

Arguments:
  slug             slug (string)
  path             path (string)

Options:
  --label <value>  Worktree label (default: main).
  --default        Mark this worktree as the default, clearing default on
                   others.
  -h, --help       display help for command
```

## active-work worktree set-default

```
Usage: active-work worktree set-default [options] <slug> <label>

Mark the named worktree label as default for an initiative; clears default on
other labels.

Arguments:
  slug        slug (string)
  label       label (string)

Options:
  -h, --help  display help for command
```

## active-work wrap

```
Usage: active-work wrap [options] <slug>

The last thing a session does. Treat it as the moment the process exits:
everything not persisted before wrap returns is lost, so file it first and wrap
last. Every category the session can leave behind needs an explicit answer, and
omitting one is an error rather than a default — open loops (--next-steps /
--resolves, or --no-loops), durable notes (--notes or --no-notes), and tasks
created this session (--tasks-filed or --no-tasks). Writes the session file and
its ledger, files the notes under sources/notes/, records any worktrees,
branches and stashes the initiative had not written down, stamps the brief's
updated date, and returns a receipt of what was filed.

Arguments:
  slug                   slug (string)

Options:
  --session-id <value>   Claude session identifier
  --started <value>      ISO 8601 session start timestamp
  --ended <value>        ISO 8601 session end timestamp
  --track <value>        'canonical' (mainline thread) | 'sidecar'
                         (folded/derived) | 'adhoc' (parallel ad-hoc work)
                         (default: canonical)
  --body <value>         Raw markdown body (session narrative)
  --body-file <value>    Path to a file containing the markdown body
  --next-steps <value>   JSON array of loops this session opens:
                         [{"id","text","kind":"task|pr|prose","ref"?}]
  --resolves <value>     JSON array of loops this session closes:
                         [{"ref":"<session-file-stem>#<id>","outcome":"done|abandoned","note"?}]
  --no-loops             Assert that this session leaves nothing hanging.
                         Records no_loops: true so a deliberate empty ledger is
                         distinguishable from an unfiled one. Mutually exclusive
                         with --next-steps / --resolves.
  --notes <value>        JSON array of durable notes to file under
                         sources/notes/:
                         [{"kind":"process|gotcha|fyi|decision","title","body","tags"?}]
  --no-notes             Assert that this session produced no durable knowledge
                         worth keeping. Mutually exclusive with --notes.
  --tasks-filed <value>  JSON array of task ids created during this session,
                         e.g. ["AW-66","AW-67"]. Each must already exist in the
                         initiative.
  --no-tasks             Assert that this session filed no tasks. Mutually
                         exclusive with --tasks-filed.
  -h, --help             display help for command
```
