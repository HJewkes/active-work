---
'@hjewkes/active-work': minor
---

AW-3: live-reload for the `/ui` dashboard. The daemon now watches the active
root and streams change notifications over a Server-Sent Events endpoint
(`GET /events`); the dashboard subscribes via `EventSource` and refetches
within ~1s of any file edit made outside the browser (CLI, editor, MCP). A
small status dot in the sidebar reflects the connection state.

Implemented with SSE rather than raw WebSockets (the task's original framing):
the payoff is one-way server→client push, which SSE delivers with zero new
runtime dependencies and automatic client reconnection — keeping the dependency
trim from AW-11 intact.

Also fixes a pre-existing packaging bug: `dashboardDir` resolved the built
bundle relative to a `dist/server/` layout that `tsup` never produces, so a
packaged install always served the "dashboard not built" placeholder instead of
the real `/ui`. It now probes the bundled, legacy, and dev layouts and serves
the first that exists.
