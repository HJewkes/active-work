import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { getActiveRoot } from '../utils/paths.js';
import { readStdinJson } from '../utils/read-stdin-json.js';
import { stashSpawnContext } from '../utils/agent-chat-hook-state.js';
import { nowIso } from '../utils/today.js';
import { resolveSlugFromCwd } from './_open-helpers.js';

/**
 * `active-work hooks agent-chat-spawn` (AW-99) — the `on_spawn` consumer
 * registered into agent-chat's generic lifecycle hooks (CC-71).
 *
 * Reads the on_spawn JSON payload from stdin
 * (`{agentId, name, session_id, cwd, parent, profile, briefing}`), resolves
 * which active-work initiative owns `cwd` via the same `resolveSlugFromCwd`
 * `open` uses, and stashes the spawn context so the matching
 * `hooks agent-chat-complete` call can record it. A cwd that resolves to no
 * initiative is a silent no-op — most agent-chat spawns are not spawned into
 * an active-work-tracked worktree, and that is not an error condition.
 *
 * Args intentionally empty: agent-chat pipes the payload as JSON on stdin,
 * not as CLI flags, so this command has no positionals/options of its own.
 */
const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  matched: z.boolean(),
  slug: z.string().nullable(),
});
type Result = z.infer<typeof ResultSchema>;

function str(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The on_spawn payload handler, separated from stdin-reading so it's unit-testable directly. */
export async function handleOnSpawn(
  payload: Record<string, unknown> | null,
  activeRoot: string,
): Promise<Result> {
  const agentId = str(payload, 'agentId');
  const cwd = str(payload, 'cwd');
  const sessionId = str(payload, 'session_id');
  if (!agentId || !cwd || !sessionId) return { matched: false, slug: null };

  const match = await resolveSlugFromCwd(activeRoot, cwd);
  if (!match) return { matched: false, slug: null };

  await stashSpawnContext(agentId, {
    slug: match.slug,
    sessionId,
    name: str(payload, 'name') ?? agentId,
    started: nowIso(),
  });
  return { matched: true, slug: match.slug };
}

export default defineCommand<Args, Result>({
  name: 'hooks.agent-chat-spawn',
  description:
    "agent-chat on_spawn hook consumer (AW-99): stash a spawned peer's context, keyed by agentId, for the matching on_complete call.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    usage: 'active-work hooks agent-chat-spawn   (reads the on_spawn JSON payload from stdin)',
  },
  async run() {
    const payload = await readStdinJson();
    return handleOnSpawn(payload, getActiveRoot());
  },
});
