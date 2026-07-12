---
description: Print the active-work bootstrap prompt for the initiative in the current directory and adopt it as session context. Use to resume or re-seed a running session.
argument-hint: [slug]
allowed-tools: Bash(active-work prompt:*)
disable-model-invocation: true
---

## active-work session context

!`active-work prompt $ARGUMENTS`

## Instructions

The block above is the bootstrap prompt for an active-work initiative — the same
context `aw` injects at launch (brief, handoff, most recent session, open tasks,
artifacts). With no argument it resolves the initiative from the current
directory; pass a slug to target a specific one.

Treat it as the source of truth for what we're working on. Continue from the
highest-priority open task unless I redirect you. Do not re-read `brief.md` or
`handoff.md` — they're already inlined above.
