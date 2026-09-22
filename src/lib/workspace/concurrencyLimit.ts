/**
 * concurrencyLimit — bounded-fan-out helper for useActiveEngagements: the returning-user hub must
 * never fire one network request per open engagement simultaneously (a firm with hundreds of open
 * engagements would otherwise fan out hundreds of parallel Supabase reads at once). Pure, no DB
 * access, no timers — a fixed-size worker pool that pulls from `items` by index.
 *
 * Guarantees:
 *   - never more than `limit` calls to `fn` in flight at once;
 *   - results[i] always corresponds to items[i] — deterministic order, independent of which
 *     item's promise actually settles first;
 *   - one item's rejection is captured on ITS OWN result only ("rejected") and never prevents or
 *     corrupts any other item's own independent result — no cross-contamination between entries.
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        const value = await fn(items[i], i);
        results[i] = { status: "fulfilled", value };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface AggregatedSettledResult<T> {
  /** Non-null fulfilled values, in the same order mapWithConcurrencyLimit returned them. */
  values: T[];
  /** True the instant ANY item rejected — the caller must fail closed, never show `values` as complete. */
  failed: boolean;
}

/**
 * Turns a PromiseSettledResult[] into "the complete list" or "failed" — never a silently partial
 * list presented as complete. One rejected engagement must never let the caller believe it saw
 * every engagement when it did not; see useActiveEngagements.ts's own "Query safety" doc comment
 * for why a partial picture here is unsafe specifically for the returning-user routing decision.
 */
export function aggregateSettledResults<T>(settled: readonly PromiseSettledResult<T | null>[]): AggregatedSettledResult<T> {
  const failed = settled.some((r) => r.status === "rejected");
  if (failed) return { values: [], failed: true };
  const values = settled
    .filter((r): r is PromiseFulfilledResult<T | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v): v is T => v !== null);
  return { values, failed: false };
}
