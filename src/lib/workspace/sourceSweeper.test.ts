/**
 * sourceSweeper.test.ts: the decision sequence of the trial-balance-source-sweeper Edge Function
 * (supabase/functions/_shared/sourceSweeper.ts), with every dependency injected.
 */
import { describe, expect, it, vi } from "vitest";
import { parseSweeperRequest, runSourceSweep, type SweepCandidate, type SweeperDeps } from "../../../supabase/functions/_shared/sourceSweeper";

const TICKET = "a".repeat(64);
const cand = (over: Partial<SweepCandidate> = {}): SweepCandidate =>
  ({ kind: "discard", target_id: "op-1", object_path: "workspaces/co/s/tb.csv", delete_object: true, ...over });

function deps(over: Partial<SweeperDeps> = {}) {
  const d = {
    redeemTicket: vi.fn(async () => true),
    listCandidates: vi.fn(async () => [cand()]),
    claim: vi.fn(async () => true),
    removeObject: vi.fn(async () => true),
    objectExists: vi.fn(async () => false as boolean | null),
    complete: vi.fn(async () => "purged" as string | null),
    ...over,
  };
  return d as typeof d & SweeperDeps;
}

describe("request parsing: only a ticket", () => {
  it("accepts exactly { ticket: 64 hex }", () => expect(parseSweeperRequest({ ticket: TICKET })).toEqual({ ticket: TICKET }));
  it("refuses paths, buckets, ids, users and malformed tickets", () => {
    for (const body of [{ ticket: TICKET, path: "x" }, { ticket: TICKET, bucket: "avatars" }, { ticket: TICKET, target_id: "x" },
      { ticket: "A".repeat(64) }, { ticket: "a".repeat(63) }, { ticket: 1 }, {}, null, [TICKET]]) expect(parseSweeperRequest(body)).toBeNull();
  });
});

describe("runSourceSweep", () => {
  it("an unredeemable ticket (forged, expired or reused) does nothing", async () => {
    const d = deps({ redeemTicket: vi.fn(async () => false) });
    await expect(runSourceSweep(d, TICKET)).resolves.toEqual({ status: 403, outcome: "forbidden" });
    expect(d.listCandidates).not.toHaveBeenCalled();
    expect(d.removeObject).not.toHaveBeenCalled();
  });
  it("deletes exactly the listed object, verifies absence, THEN records completion", async () => {
    const order: string[] = [];
    const d = deps({
      claim: vi.fn(async (k: string, id: string) => { order.push(`claim:${k}:${id}`); return true; }),
      removeObject: vi.fn(async (p: string) => { order.push(`remove:${p}`); return true; }),
      objectExists: vi.fn(async (p: string) => { order.push(`exists:${p}`); return false; }),
      complete: vi.fn(async (k: string, id: string) => { order.push(`complete:${k}:${id}`); return "purged"; }),
    });
    await expect(runSourceSweep(d, TICKET)).resolves.toMatchObject({ status: 200, outcome: "swept", tally: { purged: 1, pending: 0 } });
    expect(order).toEqual(["claim:discard:op-1", "remove:workspaces/co/s/tb.csv", "exists:workspaces/co/s/tb.csv", "complete:discard:op-1"]);
  });
  it("a failed or unverifiable deletion stays pending and is never recorded as done", async () => {
    for (const over of [{ removeObject: vi.fn(async () => false) }, { objectExists: vi.fn(async () => true) }, { objectExists: vi.fn(async () => null) }]) {
      const d = deps(over);
      await expect(runSourceSweep(d, TICKET)).resolves.toMatchObject({ tally: { pending: 1, purged: 0 } });
      expect(d.complete).not.toHaveBeenCalled();
    }
  });
  it("delete_object false (no object, or referenced by an upload) deletes nothing but still lets the DB decide", async () => {
    const d = deps({ listCandidates: vi.fn(async () => [cand({ kind: "reservation", delete_object: false })]), complete: vi.fn(async () => "reclaimed") });
    await expect(runSourceSweep(d, TICKET)).resolves.toMatchObject({ tally: { reclaimed: 1 } });
    expect(d.removeObject).not.toHaveBeenCalled();
  });
  it("an unsafe path is never deleted", async () => {
    for (const object_path of ["../x", "/abs", "", null]) {
      const d = deps({ listCandidates: vi.fn(async () => [cand({ object_path })]) });
      await expect(runSourceSweep(d, TICKET)).resolves.toMatchObject({ tally: { skipped: 1 } });
      expect(d.removeObject).not.toHaveBeenCalled();
    }
  });
  it("tallies every kind, and one failing item does not stop the rest", async () => {
    const d = deps({
      listCandidates: vi.fn(async () => [cand(), cand({ kind: "cancel_replacement", target_id: "op-2" }), cand({ kind: "reservation", target_id: "r-1" }), cand({ target_id: "op-3" })]),
      complete: vi.fn(async (k: string, id: string) => {
        if (id === "op-3") throw new Error("boom");
        return k === "discard" ? "purged" : k === "cancel_replacement" ? "completed" : "reclaimed";
      }),
    });
    await expect(runSourceSweep(d, TICKET)).resolves.toMatchObject({ tally: { purged: 1, completed: 1, reclaimed: 1, failed: 1 } });
  });
  it("listing failure → 500, nothing deleted", async () => {
    const d = deps({ listCandidates: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(runSourceSweep(d, TICKET)).resolves.toEqual({ status: 500, outcome: "sweep_failed" });
    expect(d.removeObject).not.toHaveBeenCalled();
  });
});

describe("F-05: claim before delete; F-04: stale discards resolved, never deleted", () => {
  it("an unclaimed item (restore won the race, or a live upload references the object) is not deleted or completed", async () => {
    for (const kind of ["discard", "cancel_replacement", "reservation"] as const) {
      const d = deps({ listCandidates: vi.fn(async () => [cand({ kind })]), claim: vi.fn(async () => false) });
      await expect(runSourceSweep(d, TICKET)).resolves.toMatchObject({ tally: { skipped: 1, purged: 0 } });
      expect(d.claim).toHaveBeenCalledWith(kind, "op-1");
      expect(d.removeObject).not.toHaveBeenCalled();
      expect(d.complete).not.toHaveBeenCalled();
    }
  });
  it("a claim that throws counts as failed and deletes nothing", async () => {
    const d = deps({ claim: vi.fn(async () => { throw new Error("db"); }) });
    await expect(runSourceSweep(d, TICKET)).resolves.toMatchObject({ tally: { failed: 1 } });
    expect(d.removeObject).not.toHaveBeenCalled();
  });
  it("nothing is claimed when there is nothing to delete", async () => {
    const d = deps({ listCandidates: vi.fn(async () => [cand({ delete_object: false })]) });
    await runSourceSweep(d, TICKET);
    expect(d.claim).not.toHaveBeenCalled();
  });
  it("stale_discard never claims or deletes (even if flagged), and aborted is tallied", async () => {
    const d = deps({
      listCandidates: vi.fn(async () => [cand({ kind: "stale_discard", delete_object: true })]),
      complete: vi.fn(async () => "aborted"),
    });
    await expect(runSourceSweep(d, TICKET)).resolves.toMatchObject({ tally: { aborted: 1, purged: 0 } });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.removeObject).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith("stale_discard", "op-1");
  });
});
