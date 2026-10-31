export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results come
 * back in input order whatever the completion order, and one rejection never
 * stops the rest: every item yields a {@link Settled} outcome.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  const results: Settled<R>[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { ok: true, value: await fn(items[index] as T, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
