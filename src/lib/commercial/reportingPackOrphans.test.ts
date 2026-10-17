/**
 * reportingPackOrphans.test.ts — the orphan sweeper's decision rule and sweep, as pure logic (repair C, #143).
 *
 * Adopted from BLACK's independent review (research/launch-qa/reviews/reportingPackOrphans.review.test.mjs @ 01bb7f7),
 * which found the sole deletion rule had no behavioural test in the repair's own suite. Distinct from the database proof
 * scripts/db-proof/billingSuspension.mjs (61/61: real issuances, real expiry, 12 seals during a sweep, failed-cleanup
 * recovery): this file pins the boundaries and, deterministically, a seal landing BETWEEN the sweep's two reads.
 */
import { describe, expect, it } from "vitest";
import { ORPHAN_GRACE_MS, orphanDecision, sweepReportingPackOrphans } from "../../../supabase/functions/_shared/reportingPackOrphans.mjs";

const NOW = 1_000_000_000_000;
const G = ORPHAN_GRACE_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const P = (a: string, b: string) => `${a.repeat(8)}-${a.repeat(4)}-${a.repeat(4)}-${a.repeat(4)}-${a.repeat(12)}/${b.repeat(8)}-${b.repeat(4)}-${b.repeat(4)}-${b.repeat(4)}-${b.repeat(12)}.json`;

describe("orphanDecision", () => {
  it("a sealed object is never deleted, whatever its age", () => {
    expect(orphanDecision({ created_at: iso(0) }, { expires_at: iso(0), consumed_at: iso(1) }, NOW)).toEqual({ delete: false, reason: "sealed" });
  });
  it("an issuance that may still be sealed is spared, up to and including expiry + grace", () => {
    expect(orphanDecision({}, { expires_at: iso(NOW), consumed_at: null }, NOW).delete).toBe(false);
    expect(orphanDecision({}, { expires_at: iso(NOW - G), consumed_at: null }, NOW).delete).toBe(false);
    expect(orphanDecision({}, { expires_at: iso(NOW - G - 1), consumed_at: null }, NOW)).toEqual({ delete: true, reason: "expired_unsealed" });
  });
  it("an unknown or invalid date never deletes (fail safe)", () => {
    expect(orphanDecision({}, { expires_at: "not-a-date", consumed_at: null }, NOW).delete).toBe(false);
    expect(orphanDecision({ created_at: "x" }, null, NOW).delete).toBe(false);
  });
  it("an object with no issuance follows the same grace from its creation", () => {
    expect(orphanDecision({ created_at: iso(NOW) }, null, NOW).delete).toBe(false);
    expect(orphanDecision({ created_at: iso(NOW - G - 1) }, null, NOW)).toEqual({ delete: true, reason: "no_issuance" });
  });
  it("the grace outlasts any seal still in flight: a seal is one short RPC inside one Edge request, whose worker lives at most 400 s (hosted wall clock; CLI workerTimeoutMs default)", () => {
    // No statement_timeout is configured in this repository; a database-side bound on the seal function is a release
    // decision (roadmap). This pins the margin the rule relies on today.
    expect(G).toBeGreaterThanOrEqual(9 * 400_000);
  });
});

describe("sweepReportingPackOrphans", () => {
  it("re-decides on a fresh read: a seal landing between the sweep's two reads spares the object", async () => {
    let reads = 0; const removed: string[] = [];
    const report = await sweepReportingPackOrphans({
      listOrphans: async () => [{ storage_path: P("1", "2"), created_at: iso(NOW - G - 10) }],
      issuance: async () => (++reads === 1 ? { expires_at: iso(NOW - G - 1), consumed_at: null } : { expires_at: iso(NOW - G - 1), consumed_at: iso(NOW) }),
      remove: async (p: string) => { removed.push(p); return { error: null }; },
    }, NOW, G);
    expect(removed).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.kept).toEqual([{ path: P("1", "2"), reason: "sealed" }]);
  });
  it("a genuinely expired, unsealed orphan (both reads agree) is deleted", async () => {
    const removed: string[] = [];
    const report = await sweepReportingPackOrphans({
      listOrphans: async () => [{ storage_path: P("3", "4"), created_at: iso(NOW - G - 10) }],
      issuance: async () => ({ expires_at: iso(NOW - G - 1), consumed_at: null }),
      remove: async (p: string) => { removed.push(p); return { error: null }; },
    }, NOW, G);
    expect(removed).toEqual([P("3", "4")]);
    expect(report.deleted).toEqual([{ path: P("3", "4"), reason: "expired_unsealed" }]);
  });
  it("a failed deletion is reported as failed, never as deleted; a thrown error is the same", async () => {
    for (const remove of [async () => ({ error: new Error("storage 500") }), async () => { throw new Error("network"); }]) {
      const report = await sweepReportingPackOrphans({
        listOrphans: async () => [{ storage_path: P("5", "6"), created_at: iso(NOW - G - 10) }],
        issuance: async () => null,
        remove: remove as never,
      }, NOW, G);
      expect(report.failed).toHaveLength(1);
      expect(report.deleted).toEqual([]);
    }
  });
  it("a path that does not name an issuance is treated as having none (grace from creation)", async () => {
    const report = await sweepReportingPackOrphans({
      listOrphans: async () => [{ storage_path: "not/a-pack.json", created_at: iso(NOW) }],
      issuance: async () => { throw new Error("must not be read"); },
      remove: async () => ({ error: null }),
    }, NOW, G);
    expect(report.kept).toEqual([{ path: "not/a-pack.json", reason: "recent" }]);
  });
});
