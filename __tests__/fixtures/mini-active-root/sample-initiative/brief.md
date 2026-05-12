---
schema_version: 1
title: Sample Initiative
updated: 2026-05-10
state: focused
rank: 1
ship_target: 2026-Q3
owner: hjewkes
task_prefix: SI
worktrees:
  main:
    path: ~/code/sample
    default: true
---

# Sample Initiative

This fixture exists so other tests can stand up a known-good active root.
It must always parse cleanly against the v1 schema. If schema changes,
update this file at the same time.

Why we care: the bootstrap path, picker, audit, and several command
implementations need to read from a real-shaped directory tree.
