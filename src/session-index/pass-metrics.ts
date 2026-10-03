/** Offset advance per transcript row; a row whose offset fell was re-read from byte 0. */
export function bytesAdvanced(before: Map<number, number>, after: Map<number, number>): number {
  let total = 0;
  for (const [sourceId, offset] of after) {
    const was = before.get(sourceId) ?? 0;
    total += offset >= was ? offset - was : offset;
  }
  return total;
}

/** Each call returns the milliseconds since the previous one (or since creation). */
export function lapTimer(): () => number {
  let last = Date.now();
  return () => {
    const now = Date.now();
    const lap = now - last;
    last = now;
    return lap;
  };
}
