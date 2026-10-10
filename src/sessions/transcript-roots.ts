import { claudeTranscriptRoots, type TranscriptRoot } from '@titan-design/session-read';

/**
 * session-read stamps `host` on a root mirrored from another machine
 * (`CLAUDE_TRANSCRIPT_MIRRORS`); a root on this machine has none. Releases
 * before mirrors never set it, so the field is read rather than typed.
 */
export function transcriptRootHost(root: TranscriptRoot): string | undefined {
  const { host } = root as TranscriptRoot & { host?: unknown };
  return typeof host === 'string' && host.length > 0 ? host : undefined;
}

/**
 * The roots of this machine's config dirs. A mirror is a read-only copy of
 * another machine's transcripts: no config dir here owns it, so nothing may
 * resume or recover a session from it.
 */
export function localTranscriptRoots(): TranscriptRoot[] {
  return claudeTranscriptRoots().filter((root) => transcriptRootHost(root) === undefined);
}
