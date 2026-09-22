import { describe, expect, it } from "vitest";
import { mapWithConcurrencyLimit, aggregateSettledResults } from "./concurrencyLimit";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mapWithConcurrencyLimit — bounded fan-out for the returning-user hub", () => {
  it("never runs more than `limit` calls concurrently", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrencyLimit(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return item * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(items.map((i) => i * 2));
  });

  it("preserves order deterministically — results[i] matches items[i] even when later items resolve first", async () => {
    const slow = deferred<string>();
    const items = ["slow", "fast"];

    const promise = mapWithConcurrencyLimit(items, 2, async (item) => {
      if (item === "slow") return slow.promise;
      return "fast-result";
    });

    // Let the fast one resolve first, then the slow one.
    await new Promise((r) => setTimeout(r, 0));
    slow.resolve("slow-result");

    const results = await promise;
    expect(results[0]).toEqual({ status: "fulfilled", value: "slow-result" });
    expect(results[1]).toEqual({ status: "fulfilled", value: "fast-result" });
  });

  it("one item's rejection is captured on its own result only — every other item's own result is untouched (no cross-contamination)", async () => {
    const items = [1, 2, 3, 4];
    const results = await mapWithConcurrencyLimit(items, 2, async (item) => {
      if (item === 2) throw new Error("item 2 failed");
      return `ok-${item}`;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: "ok-1" });
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toBe("item 2 failed");
    expect(results[2]).toEqual({ status: "fulfilled", value: "ok-3" });
    expect(results[3]).toEqual({ status: "fulfilled", value: "ok-4" });
  });

  it("multiple independent rejections are each captured at their own index — none mixed up or dropped", async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrencyLimit(items, 3, async (item) => {
      if (item !== 2) throw new Error(`failed-${item}`);
      return "ok-2";
    });

    expect((results[0] as PromiseRejectedResult).reason.message).toBe("failed-1");
    expect(results[1]).toEqual({ status: "fulfilled", value: "ok-2" });
    expect((results[2] as PromiseRejectedResult).reason.message).toBe("failed-3");
  });

  it("empty input returns immediately with an empty array", async () => {
    const results = await mapWithConcurrencyLimit([], 5, async () => "unused");
    expect(results).toEqual([]);
  });

  it("limit larger than the item count behaves like unbounded, still deterministic", async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrencyLimit(items, 100, async (i) => i * 10);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([10, 20, 30]);
  });
});

describe("aggregateSettledResults — fail closed on any partial failure (the hub's own query-safety guarantee)", () => {
  it("all fulfilled, no nulls: returns the complete values, failed:false", () => {
    const settled: PromiseSettledResult<number | null>[] = [
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ];
    expect(aggregateSettledResults(settled)).toEqual({ values: [1, 2], failed: false });
  });

  it("fulfilled nulls are dropped (never guessed) without being treated as a failure", () => {
    const settled: PromiseSettledResult<number | null>[] = [
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: null },
      { status: "fulfilled", value: 2 },
    ];
    expect(aggregateSettledResults(settled)).toEqual({ values: [1, 2], failed: false });
  });

  it("ONE rejection among many fulfilled: fails closed — values is empty, never a silently partial list", () => {
    const settled: PromiseSettledResult<number | null>[] = [
      { status: "fulfilled", value: 1 },
      { status: "rejected", reason: new Error("boom") },
      { status: "fulfilled", value: 2 },
    ];
    expect(aggregateSettledResults(settled)).toEqual({ values: [], failed: true });
  });

  it("all rejected: fails closed the same way as one rejection", () => {
    const settled: PromiseSettledResult<number | null>[] = [
      { status: "rejected", reason: new Error("a") },
      { status: "rejected", reason: new Error("b") },
    ];
    expect(aggregateSettledResults(settled)).toEqual({ values: [], failed: true });
  });

  it("empty input: not a failure, just an empty complete list", () => {
    expect(aggregateSettledResults([])).toEqual({ values: [], failed: false });
  });
});
