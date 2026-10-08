/**
 * Bounded-parallel map. Runs `worker(item)` for each item in `items`,
 * with at most `concurrency` in-flight at any time. Preserves order.
 */
export async function mapConcurrent<I, O>(
  items: I[],
  concurrency: number,
  worker: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => pump());
  await Promise.all(lanes);
  return results;
}
