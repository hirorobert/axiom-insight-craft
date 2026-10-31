import { describe, expect, it } from "vitest";
import { HarnessFailure, Scope, awaitCheckpoint, awaitCondition, checkpoint, runCase } from "../../../scripts/db-proof/lib/checkpoints.mjs";

// The harness helpers behind scripts/db-proof/sourceAccessAuthority.mjs: no wait can hang, and every failure is structured.
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as HarnessFailure; } throw new Error("expected a failure"); };

describe("awaitCheckpoint", () => {
  it("returns what the code under test passed when the checkpoint is reached, and the code stays parked until released", async () => {
    const cp = checkpoint("after-signing");
    let after = false;
    const op = (async () => { await cp.hit({ pid: 7 }); after = true; return "done"; })();
    await expect(awaitCheckpoint(cp, op, { what: "op" })).resolves.toEqual({ pid: 7 });
    expect(after).toBe(false);
    cp.release();
    await expect(op).resolves.toBe("done");
  });
  it("a callback that is never called fails with checkpoint_timeout within the deadline", async () => {
    const cp = checkpoint("never");
    const never = new Promise(() => {});
    const f = await failure(awaitCheckpoint(cp, never, { deadlineMs: 40, what: "op" }));
    expect(f).toBeInstanceOf(HarnessFailure);
    expect(f.code).toBe("checkpoint_timeout");
  });
  it("an operation that completes before the checkpoint fails with operation_completed_early, naming the result", async () => {
    const f = await failure(awaitCheckpoint(checkpoint("late"), Promise.resolve({ outcome: "ready" }), { deadlineMs: 1000, what: "op" }));
    expect(f.code).toBe("operation_completed_early");
    expect(f.message).toContain("ready");
  });
  it("an operation that throws before the checkpoint fails with operation_threw and keeps the cause", async () => {
    const boom = new Error("boom");
    const f = await failure(awaitCheckpoint(checkpoint("late"), Promise.reject(boom), { deadlineMs: 1000, what: "op" }));
    expect(f.code).toBe("operation_threw");
    expect(f.cause).toBe(boom);
  });
});

describe("awaitCondition", () => {
  it("returns when the condition holds, and fails with condition_timeout when it never does", async () => {
    let n = 0;
    await expect(awaitCondition("count", async () => ++n >= 3, undefined, { deadlineMs: 1000, intervalMs: 1 })).resolves.toBe(true);
    expect((await failure(awaitCondition("never", async () => false, undefined, { deadlineMs: 30, intervalMs: 5 }))).code).toBe("condition_timeout");
  });
  it("an operation that settles first is a structured failure, unless settling is allowed", async () => {
    expect((await failure(awaitCondition("blocked", async () => false, Promise.resolve("ok"), { deadlineMs: 1000, intervalMs: 5 }))).code).toBe("operation_completed_early");
    expect((await failure(awaitCondition("blocked", async () => false, Promise.reject(new Error("x")), { deadlineMs: 1000, intervalMs: 5 }))).code).toBe("operation_threw");
    await expect(awaitCondition("blocked", async () => false, Promise.resolve("ok"), { deadlineMs: 1000, intervalMs: 5, allowSettle: true })).resolves.toBe(false);
  });
});

describe("Scope and runCase", () => {
  it("runs every cleanup step, last registered first, even when one throws", async () => {
    const order: string[] = [];
    const s = new Scope();
    s.defer(() => { order.push("a"); });
    s.defer(() => { order.push("b"); throw new Error("b failed"); });
    s.defer(() => { order.push("c"); });
    const errors = await s.close();
    expect(order).toEqual(["c", "b", "a"]);
    expect(errors).toHaveLength(1);
  });
  it("a case body that throws still has its cleanup run, and the error is the case's", async () => {
    let cleaned = false;
    const f = await failure(runCase(async (scope: Scope) => { scope.defer(() => { cleaned = true; }); throw new Error("inside"); }));
    expect(f.message).toBe("inside");
    expect(cleaned).toBe(true);
  });
  it("a case that never finishes is cut off at its deadline with case_deadline and its cleanup releases whatever it held", async () => {
    let released = false;
    const f = await failure(runCase(async (scope: Scope) => { scope.defer(() => { released = true; }); await new Promise(() => {}); }, { deadlineMs: 40 }));
    expect(f.code).toBe("case_deadline");
    expect(released).toBe(true);
  });
});
