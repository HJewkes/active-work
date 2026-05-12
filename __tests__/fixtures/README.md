# Test fixtures

`mini-active-root/` is the canonical fixture used by `withTempActiveRoot` (see `__tests__/setup/test-helpers.ts`). It contains a single `sample-initiative` with one brief, one handoff, two tasks, one session, and an artifacts file — enough for bootstrap, picker, audit, and most command tests to read against a real-shaped tree. Every file here must validate against the current v1 schemas at all times; if a schema changes, update the fixture in the same commit so this directory always represents a working active root.
