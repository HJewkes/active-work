#!/usr/bin/env bash
# Builds the CLI, runs the tests under a throwaway HOME, then smoke-tests the CLI-reference generator.
set -euo pipefail

cd "$(dirname "$0")/.."

# AW-12: integration tests spawn a prebuilt dist/cli.js, not src through tsx.
pnpm build:cli

# Not aw-test-*: test-helpers treats that shape under the temp dir as its own and deletable.
tmp_base="${TMPDIR:-/tmp}"
sandbox_home="$(mktemp -d "${tmp_base%/}/aw-verify-home.XXXXXX")"
trap 'rm -rf "$sandbox_home"' EXIT

# AW-9: spawned CLI children must never see the real home or config dirs.
HOME="$sandbox_home" \
  XDG_CONFIG_HOME="$sandbox_home/.config" \
  XDG_DATA_HOME="$sandbox_home/.local/share" \
  XDG_STATE_HOME="$sandbox_home/.local/state" \
  pnpm exec vitest run

# TP-34: the reference is generated only at release, so exercise the generator on every PR.
node scripts/gen-cli-reference.mjs
test -s docs/cli-reference.md || { echo "cli-reference.md missing or empty" >&2; exit 1; }
