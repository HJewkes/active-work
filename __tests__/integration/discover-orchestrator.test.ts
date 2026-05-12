/**
 * Integration: discover orchestrator with real subprocess shims.
 *
 * We exercise the orchestrator's full pipeline (gh, git, projects, claude
 * sessions) by prepending a temp directory containing shell-script shims for
 * `gh` and `git` to PATH. This means the orchestrator's real `runCommand`
 * spawns our scripts unmodified — no internal mocks. The Claude scanner is
 * driven by handcrafted JSONLs under `CLAUDE_PROJECTS_ROOT`.
 *
 * The slug-match cross-reference is verified by setting up two initiatives
 * and asserting the orchestrator only binds the matching one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import '../../src/commands/index.js';
import { runDiscovery } from '../../src/discover/index.js';

interface ShimRoot {
  dir: string;
  pathPrepend: string;
}

function makeShim(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  writeFileSync(file, body, { encoding: 'utf8' });
  chmodSync(file, 0o755);
}

/**
 * Build a temp PATH directory and write `gh` + `git` shim scripts. The
 * scripts dispatch on argv to the canned outputs the orchestrator expects.
 */
function buildShims(): ShimRoot {
  const dir = mkdtempSync(path.join(tmpdir(), 'aw-shims-'));

  // gh shim — emits a single open PR matching --repo arg.
  makeShim(
    dir,
    'gh',
    `#!/usr/bin/env bash
# Args look like: pr list --author @me --state open --limit 100 --repo owner/repo --json ...
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[
  {
    "number": 7,
    "title": "WIP: discover-target work",
    "isDraft": true,
    "headRefName": "feat/discover-target",
    "updatedAt": "2026-05-10T12:00:00Z"
  }
]
JSON
  exit 0
fi
echo "unrecognised gh invocation: $*" >&2
exit 1
`,
  );

  // git shim — dispatches on subcommand.
  makeShim(
    dir,
    'git',
    `#!/usr/bin/env bash
# Strip leading "-C <path>" if present so we can branch on the real subcommand.
while [ "$1" = "-C" ]; do
  shift; shift
done
case "$1" in
  for-each-ref)
    printf 'feat/discover-target|2026-05-10|sketch target work\\n'
    printf 'feat/unrelated|2026-05-09|other thing\\n'
    exit 0
    ;;
  worktree)
    printf 'worktree /tmp/repo\\nHEAD abc\\nbranch refs/heads/main\\n\\n'
    exit 0
    ;;
  stash)
    # No stashes.
    exit 0
    ;;
  *)
    echo "unrecognised git invocation: $*" >&2
    exit 1
    ;;
esac
`,
  );

  return { dir, pathPrepend: `${dir}${path.delimiter}${process.env.PATH ?? ''}` };
}

describe('integration: discover orchestrator with real subprocess shims', () => {
  let activeRoot: string;
  let claudeRoot: string;
  let projectsRoot: string;
  let shim: ShimRoot;
  let originalPath: string | undefined;
  let originalActiveRoot: string | undefined;
  let originalClaudeRoot: string | undefined;

  beforeEach(() => {
    activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-disc-active-'));
    claudeRoot = mkdtempSync(path.join(tmpdir(), 'aw-disc-claude-'));
    projectsRoot = mkdtempSync(path.join(tmpdir(), 'aw-disc-projects-'));
    shim = buildShims();

    originalPath = process.env.PATH;
    originalActiveRoot = process.env.ACTIVE_ROOT;
    originalClaudeRoot = process.env.CLAUDE_PROJECTS_ROOT;

    process.env.PATH = shim.pathPrepend;
    process.env.ACTIVE_ROOT = activeRoot;
    process.env.CLAUDE_PROJECTS_ROOT = claudeRoot;

    // Two initiatives so the slug_match logic has more than one option.
    mkdirSync(path.join(activeRoot, 'discover-target'));
    writeFileSync(
      path.join(activeRoot, 'discover-target', 'brief.md'),
      `---\nschema_version: 1\ntitle: Discover Target\nupdated: 2026-05-12\nstate: focused\nrank: 1\ntask_prefix: DT\n---\n\n# Discover Target\n`,
    );
    mkdirSync(path.join(activeRoot, 'unrelated-init'));
    writeFileSync(
      path.join(activeRoot, 'unrelated-init', 'brief.md'),
      `---\nschema_version: 1\ntitle: Unrelated\nupdated: 2026-05-12\nstate: focused\nrank: 2\ntask_prefix: U\n---\n\n# Unrelated\n`,
    );

    // A Claude session JSONL whose cwd contains the matching slug as a substring.
    const sessionDir = path.join(claudeRoot, '-Users-anon-code-discover-target');
    mkdirSync(sessionDir);
    writeFileSync(
      path.join(sessionDir, 'sess-1.jsonl'),
      JSON.stringify({
        type: 'user',
        cwd: '/Users/anon/code/discover-target',
        message: { content: 'continue the work' },
      }) + '\n',
    );

    // A bare projects-root subdir whose name does NOT contain any slug.
    mkdirSync(path.join(projectsRoot, 'other-thing'));
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalActiveRoot === undefined) delete process.env.ACTIVE_ROOT;
    else process.env.ACTIVE_ROOT = originalActiveRoot;
    if (originalClaudeRoot === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = originalClaudeRoot;

    rmSync(activeRoot, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(projectsRoot, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });

  it('returns hits from gh, git, projects, and claude sources', async () => {
    const result = await runDiscovery({
      github_repos: ['owner/repo'],
      local_repos: ['/tmp/fake-repo'],
      projects_root: projectsRoot,
    });

    const sources = new Set(result.hits.map((h) => h.source));
    expect(sources.has('gh:owner/repo')).toBe(true);
    expect([...sources].some((s) => s.startsWith('branch:'))).toBe(true);
    expect(sources.has('projects')).toBe(true);
    expect(sources.has('claude-session')).toBe(true);

    // Per-source error list is empty when shims succeed.
    expect(result.errors).toEqual([]);
  });

  it('cross-references ref / cwd substrings against known slugs and only binds matches', async () => {
    const result = await runDiscovery({
      github_repos: ['owner/repo'],
      local_repos: ['/tmp/fake-repo'],
      projects_root: projectsRoot,
    });

    // gh PR's headRefName is `feat/discover-target` — contains the slug.
    const ghHit = result.hits.find((h) => h.source === 'gh:owner/repo');
    expect(ghHit?.slug_match).toBe('discover-target');
    expect(ghHit?.untracked).toBe(false);

    // Git branch ref `feat/discover-target` matches the slug.
    const matchingBranch = result.hits.find(
      (h) => h.source.startsWith('branch:') && h.ref === 'feat/discover-target',
    );
    expect(matchingBranch?.slug_match).toBe('discover-target');

    // Git branch ref `feat/unrelated` should NOT bind `unrelated-init` because
    // the slug substring isn't present in the ref.
    const unrelatedBranch = result.hits.find(
      (h) => h.source.startsWith('branch:') && h.ref === 'feat/unrelated',
    );
    expect(unrelatedBranch?.slug_match).toBeUndefined();
    expect(unrelatedBranch?.untracked).toBe(true);

    // Claude session metadata.cwd contains the slug.
    const claudeHit = result.hits.find((h) => h.source === 'claude-session');
    expect(claudeHit?.slug_match).toBe('discover-target');

    // The projects-root entry doesn't contain any slug substring.
    const projectsHit = result.hits.find((h) => h.source === 'projects');
    expect(projectsHit?.slug_match).toBeUndefined();
    expect(projectsHit?.untracked).toBe(true);
  });
});
