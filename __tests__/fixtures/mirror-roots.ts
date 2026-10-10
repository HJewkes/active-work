import path from 'node:path';
import type * as SessionRead from '@titan-design/session-read';

/** A read-only copy of another machine's transcripts, as `CLAUDE_TRANSCRIPT_MIRRORS` names one. */
export interface MirrorRoot {
  root: string;
  account: string;
  host: string;
}

/** The mirror roots `claudeTranscriptRoots` appends while a test runs; empty it in `afterEach`. */
export const mirrorRoots: MirrorRoot[] = [];

/** `<dir>/<account>/projects`, the layout a mirror dir holds per account. */
export function mirrorRoot(dir: string, account: string, host = 'mac'): MirrorRoot {
  return { root: path.join(dir, account, 'projects'), account, host };
}

/**
 * The installed session-read predates mirror roots (titan-platform TP-2171), so this stands in
 * for `CLAUDE_TRANSCRIPT_MIRRORS`: the real roots, then each mirror root with its `host`.
 * Use as `vi.mock('@titan-design/session-read', async (orig) => (await import(...)).withMirrors(orig))`.
 */
export async function withMirrors(
  importOriginal: () => Promise<typeof SessionRead>,
): Promise<typeof SessionRead> {
  const actual = await importOriginal();
  return {
    ...actual,
    claudeTranscriptRoots: (env?: NodeJS.ProcessEnv) => [
      ...actual.claudeTranscriptRoots(env),
      ...mirrorRoots,
    ],
  };
}
