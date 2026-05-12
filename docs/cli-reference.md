# CLI reference

Generated from `aw --help` and individual command `--help` outputs.
Re-run `node scripts/gen-cli-reference.mjs` to refresh after the CLI
surface changes.

## aw

Top-level help. Run `aw <command> --help` for command-specific options.

```
Usage: aw [options] [command]

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
  discover [options]            Scan configured sources (gh PRs, local git,
                                projects root, Claude sessions) and emit
                                unfiltered discovery hits.
  drop [options] <ref>          Mark a discover hit as dropped so future
                                discovers suppress it.
  edit <slug> <target>          Open the operator's editor on brief.md or
                                handoff.md.
  focus [options] <slug>        Promote an initiative into the focused list at a
                                given rank.
  fold [options] <ref>          Mark a discover hit as folded into an existing
                                initiative.
  list                          List every initiative grouped by state. Replaces
                                the legacy INDEX.md dump.
  mcp                           mcp commands
  new [options] <slug>          Scaffold a new initiative directory.
  open [slug]                   Bootstrap a Claude session for an initiative.
                                Without a slug, returns the picker list of known
                                initiatives.
  paths <slug>                  Print all artifact paths for an initiative.
  pause [options] <slug>        Mark an initiative as paused with required
                                restart metadata.
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
  help [command]                display help for command

Run `aw <command> --help` for command-specific options.
```

## aw archive

```
Usage: aw archive [options] <slug> <domain>

Move an initiative out of active root into <archiveRoot>/<domain>/archive/.

Arguments:
  slug        slug (string)
  domain      domain (string)

Options:
  -h, --help  display help for command
```

## aw artifact add-branch

```
Usage: aw artifact add-branch [options] <slug>

Append or upsert a branch entry in artifacts.yml.

Arguments:
  slug                   slug (string)

Options:
  --repo <value>         Repo path or org/repo
  --name <value>         Branch name
  --last-commit <value>  Last commit date YYYY-MM-DD
  -h, --help             display help for command
```

## aw artifact add-pr

```
Usage: aw artifact add-pr [options] <slug>

Append or upsert a PR entry in artifacts.yml.

Arguments:
  slug              slug (string)

Options:
  --number <value>  PR number
  --repo <value>    org/repo
  --title <value>   PR title
  --status <value>  open | merged | closed
  -h, --help        display help for command
```

## aw artifact add-stash

```
Usage: aw artifact add-stash [options] <slug>

Append a stash entry to artifacts.yml.

Arguments:
  slug               slug (string)

Options:
  --repo <value>     Repo path
  --message <value>  Stash message
  --created <value>  Created date YYYY-MM-DD
  -h, --help         display help for command
```

## aw artifact check

```
Usage: aw artifact check [options] <slug>

Refresh PR statuses in artifacts.yml via `gh pr view`.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## aw artifact list

```
Usage: aw artifact list [options] [slug]

List artifacts for a slug or across all initiatives.

Arguments:
  slug               slug (string)

Options:
  --all-initiatives  Return artifacts for every initiative
  -h, --help         display help for command
```

## aw audit

```
Usage: aw audit [options]

Cross-initiative summary: lists every initiative, parse failures, and worktree
path conflicts.

Options:
  -h, --help  display help for command
```

## aw discover

```
Usage: aw discover [options]

Scan configured sources (gh PRs, local git, projects root, Claude sessions) and
emit unfiltered discovery hits.

Options:
  --github-repos <value>   Comma-separated owner/repo list for gh PR discovery
  --local-repos <value>    Comma-separated repo paths for local git discovery
  --projects-root <value>  Root directory whose subdirs are scanned as projects
  -h, --help               display help for command
```

## aw drop

```
Usage: aw drop [options] <ref>

Mark a discover hit as dropped so future discovers suppress it.

Arguments:
  ref               ref (string)

Options:
  --reason <value>  Optional one-line reason recorded in the triage log
  -h, --help        display help for command
```

## aw edit

```
Usage: aw edit [options] <slug> <target>

Open the operator's editor on brief.md or handoff.md.

Arguments:
  slug        slug (string)
  target      target (enum)

Options:
  -h, --help  display help for command
```

## aw focus

```
Usage: aw focus [options] <slug>

Promote an initiative into the focused list at a given rank.

Arguments:
  slug            slug (string)

Options:
  --rank <value>  Target rank (positive integer). Defaults to end of list.
  -h, --help      display help for command
```

## aw fold

```
Usage: aw fold [options] <ref>

Mark a discover hit as folded into an existing initiative.

Arguments:
  ref             ref (string)

Options:
  --into <value>  Slug of the initiative this hit is folded into
  --note <value>  Optional human note describing the fold
  -h, --help      display help for command
```

## aw list

```
Usage: aw list [options]

List every initiative grouped by state. Replaces the legacy INDEX.md dump.

Options:
  -h, --help  display help for command
```

## aw mcp logs

```
Usage: aw mcp logs [options]

Return the last N lines of the daemon log (default 50).

Options:
  --lines <value>  Number of trailing lines to return (default 50).
  -h, --help       display help for command
```

## aw mcp restart

```
Usage: aw mcp restart [options]

Restart the MCP HTTP daemon (stop, then spawn a fresh detached instance).

Options:
  --port <value>  Port for the restarted daemon (default: previous port or
                  7400).
  -h, --help      display help for command
```

## aw mcp serve

```
Usage: aw mcp serve [options]

Start the MCP server. --stdio for stdio mode; --detach to fork the HTTP daemon;
otherwise runs the HTTP daemon in the foreground.

Options:
  --stdio         Run in stdio mode for Claude Code `claude mcp add`.
  --detach        Spawn the HTTP daemon in the background and return.
  --port <value>  TCP port for the HTTP daemon (default 7400).
  -h, --help      display help for command
```

## aw mcp status

```
Usage: aw mcp status [options]

Report the MCP HTTP daemon status (pid, port, version, uptime).

Options:
  -h, --help  display help for command
```

## aw mcp stop

```
Usage: aw mcp stop [options]

Stop the running MCP HTTP daemon (sends SIGTERM, waits for exit).

Options:
  -h, --help  display help for command
```

## aw new

```
Usage: aw new [options] <slug>

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

## aw open

```
Usage: aw open [options] [slug]

Bootstrap a Claude session for an initiative. Without a slug, returns the picker
list of known initiatives.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## aw paths

```
Usage: aw paths [options] <slug>

Print all artifact paths for an initiative.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## aw pause

```
Usage: aw pause [options] <slug>

Mark an initiative as paused with required restart metadata.

Arguments:
  slug                       slug (string)

Options:
  --since <value>            Pause-since date (YYYY-MM-DD).
  --restart-trigger <value>  What event should cause this initiative to resume.
  -h, --help                 display help for command
```

## aw rename

```
Usage: aw rename [options] <old_slug> <new_slug>

Rename an initiative slug (moves the directory; task_prefix unchanged).

Arguments:
  old_slug    old_slug (string)
  new_slug    new_slug (string)

Options:
  -h, --help  display help for command
```

## aw session list

```
Usage: aw session list [options] <slug>

List session summaries for an initiative, sorted by end time

Arguments:
  slug             slug (string)

Options:
  --limit <value>  Maximum sessions to return (default 100)
  -h, --help       display help for command
```

## aw session record

```
Usage: aw session record [options] <slug>

Write a session summary file under <slug>/sessions/

Arguments:
  slug                  slug (string)

Options:
  --session-id <value>  Claude session identifier
  --started <value>     ISO 8601 session start timestamp
  --ended <value>       ISO 8601 session end timestamp
  --track <value>       'canonical' | 'sidecar' (default: canonical)
  --body <value>        Raw markdown body
  --body-file <value>   Path to a file containing the markdown body
  -h, --help            display help for command
```

## aw sessions

```
Usage: aw sessions [options]

Browse recent Claude sessions discovered under ~/.claude/projects.

Options:
  --limit <value>   Max sessions to return (default 50).
  --include-active  Include sessions whose cwd lives under an active initiative.
  -h, --help        display help for command
```

## aw set

```
Usage: aw set [options] <slug> <field> <value>

Set a single field on an initiative brief.md frontmatter.

Arguments:
  slug        slug (string)
  field       field (string)
  value       value (unknown)

Options:
  -h, --help  display help for command
```

## aw setup

```
Usage: aw setup [options]

Interactive wizard: verifies Node, scaffolds directories, registers the MCP
server, and optionally starts the daemon and walks through ingestion.

Options:
  --update    Re-run setup idempotently (may overwrite the config stub).
  -y, --yes   Skip all prompts; use defaults (no daemon, no ingestion).
  -h, --help  display help for command
```

## aw source add

```
Usage: aw source add [options] <slug> <file>

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

## aw task add

```
Usage: aw task add [options] <slug>

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

## aw task delete

```
Usage: aw task delete [options] <slug> <id>

Hard delete a task file (prefer task.done in normal use)

Arguments:
  slug        slug (string)
  id          id (string)

Options:
  -h, --help  display help for command
```

## aw task done

```
Usage: aw task done [options] <slug> <id>

Mark a task as done

Arguments:
  slug        slug (string)
  id          id (string)

Options:
  -h, --help  display help for command
```

## aw task edit

```
Usage: aw task edit [options] <slug> <id> <field> <value>

Edit a single field on a task

Arguments:
  slug        slug (string)
  id          id (string)
  field       field (string)
  value       value (unknown)

Options:
  -h, --help  display help for command
```

## aw task list

```
Usage: aw task list [options] [slug]

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

## aw task reorder

```
Usage: aw task reorder [options] <slug> <id> <new_priority>

Move a task to a new priority and shift siblings down

Arguments:
  slug          slug (string)
  id            id (string)
  new_priority  new_priority (number)

Options:
  -h, --help    display help for command
```

## aw touch

```
Usage: aw touch [options] <slug>

Stamp `updated: today()` on an initiative's brief.md.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## aw track

```
Usage: aw track [options] <ref>

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

## aw unfocus

```
Usage: aw unfocus [options] <slug>

Demote a focused initiative to backburner and renumber survivors.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## aw uninstall

```
Usage: aw uninstall [options]

Reverse what setup did: remove the skill, stop the daemon, unregister MCP.
Preserves the active root.

Options:
  -y, --yes   Skip all prompts; assume yes.
  -h, --help  display help for command
```

## aw unpause

```
Usage: aw unpause [options] <slug>

Move a paused initiative back to backburner.

Arguments:
  slug        slug (string)

Options:
  -h, --help  display help for command
```

## aw worktree set-default

```
Usage: aw worktree set-default [options] <slug> <label>

Mark the named worktree label as default for an initiative; clears default on
other labels.

Arguments:
  slug        slug (string)
  label       label (string)

Options:
  -h, --help  display help for command
```
