/**
 * The version of the build that is actually running, injected by tsup from
 * package.json (see `define` in tsup.config.ts).
 *
 * It was a hardcoded `'0.1.0'` in two places through 0.4.0, which made
 * `--version` and `/health` answer the one question they exist to answer —
 * which build is live — with a constant. The daemon runs the globally installed
 * binary rather than the repo, so that question comes up every time something
 * behaves unexpectedly, and a wrong answer costs a debugging session.
 *
 * Not under `server/`, because the CLI reports it too: it describes the build,
 * not the daemon.
 *
 * `0.0.0-dev` under vitest and tsx, where nothing substitutes the define. That
 * is the honest value for an unbuilt tree, and it is visibly not a release.
 */
export const BUILD_VERSION = process.env.AW_VERSION ?? '0.0.0-dev';
