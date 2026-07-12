---
'@hjewkes/active-work': minor
---

AW-20: add `--adhoc` to `aw` / `active-work open` / `active-work prompt`. It
reframes the bootstrap prompt for ad-hoc work related to a workstream that
isn't a continuation of its handoff or top task. The same context is rendered,
but the opening and closing directives change: instead of "work the top task
unless redirected," the prompt says the context is background, tells the session
not to assume it's continuing the handoff, and to wait for the user to describe
the specific ad-hoc task before acting. `aw <slug> --adhoc` launches such a
session; `open`/`prompt --adhoc` produce the reframed prompt for other callers.
