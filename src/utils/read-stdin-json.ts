/**
 * AW-99: agent-chat's hooks (CC-71) pipe their event payload as JSON on
 * stdin. Injectable so tests can supply a payload without a real pipe.
 */
export async function readStdinJson(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
