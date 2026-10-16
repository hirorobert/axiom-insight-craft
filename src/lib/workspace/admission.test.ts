/**
 * admission.test.ts — controlled admission for process-trial-balance (supabase/functions/_shared/admission.ts).
 * The real function under 4-way load at the account limit is exercised by scripts/e2e/draftJourney.mjs (CI).
 */
import { describe, expect, it, vi } from "vitest";
import { combineAdmissions, createAdmission, createSlotAdmission, withAdmission } from "../../../supabase/functions/_shared/admission";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createAdmission", () => {
  it("admits up to the limit at once; the next waits and is granted, in arrival order, when a slot frees", async () => {
    const a = createAdmission(2, 1_000);
    const r1 = await a.acquire(), r2 = await a.acquire();
    const order: number[] = [];
    const p3 = a.acquire().then((r) => { order.push(3); return r; });
    const p4 = a.acquire().then((r) => { order.push(4); return r; });
    await tick();
    expect(a.state()).toEqual({ active: 2, waiting: 2 });
    r1!();
    const r3 = await p3;
    expect(order).toEqual([3]);
    r2!();
    const r4 = await p4;
    expect(order).toEqual([3, 4]);
    expect(a.state()).toEqual({ active: 2, waiting: 0 });
    r3!(); r4!();
    expect(a.state()).toEqual({ active: 0, waiting: 0 });
  });

  it("a waiter not granted within the bound is refused (null) and leaves the queue; nothing leaks", async () => {
    vi.useFakeTimers();
    try {
      const a = createAdmission(1, 25_000);
      const r1 = await a.acquire();
      const p = a.acquire();
      vi.advanceTimersByTime(25_001);
      expect(await p).toBeNull();
      expect(a.state()).toEqual({ active: 1, waiting: 0 });
      r1!();
      expect(a.state()).toEqual({ active: 0, waiting: 0 });
    } finally { vi.useRealTimers(); }
  });

  it("releasing twice frees one slot only", async () => {
    const a = createAdmission(1, 1_000);
    const r = await a.acquire();
    r!(); r!();
    expect(a.state()).toEqual({ active: 0, waiting: 0 });
    expect(await a.acquire()).not.toBeNull();
    expect(a.state().active).toBe(1);
  });
});

describe("withAdmission", () => {
  it("OPTIONS passes straight through; a busy refusal never runs the handler; a failing handler still frees its slot", async () => {
    const a = createAdmission(1, 10);
    let release: () => void = () => {};
    const handler = vi.fn(async (req: Request) => {
      if (req.headers.get("x-hold")) await new Promise<void>((r) => { release = r; });
      if (req.headers.get("x-throw")) throw new Error("boom");
      return new Response("ok");
    });
    const wrapped = withAdmission(a, () => new Response("busy", { status: 503 }), handler);
    expect((await wrapped(new Request("http://x", { method: "OPTIONS" }))).status).toBe(200);
    const held = wrapped(new Request("http://x", { method: "POST", headers: { "x-hold": "1" } }));
    await tick();
    const busy = await wrapped(new Request("http://x", { method: "POST" }));
    expect(busy.status).toBe(503);
    expect(handler).toHaveBeenCalledTimes(2); // OPTIONS and the held one — never the refused one
    release();
    await held;
    await expect(wrapped(new Request("http://x", { method: "POST", headers: { "x-throw": "1" } }))).rejects.toThrow("boom");
    expect(a.state()).toEqual({ active: 0, waiting: 0 });
  });
});

describe("createSlotAdmission — slots shared by every worker (tb_processing_slots)", () => {
  const slots = (n: number) => {
    const held = new Map<string, number>();
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      const h = String(args.p_holder);
      if (fn === "tb_acquire_processing_slot") {
        if (held.has(h)) return { data: held.get(h)!, error: null };
        const used = new Set(held.values());
        for (let s = 1; s <= n; s++) if (!used.has(s)) { held.set(h, s); return { data: s, error: null }; }
        return { data: null, error: null };
      }
      held.delete(h); return { data: true, error: null };
    };
    return { rpc, held };
  };
  it("takes a free slot, polls while none is free, and gives up (null) at the wait bound without holding anything", async () => {
    const w = slots(1);
    const a = createSlotAdmission(w.rpc, { maxWaitMs: 60, pollMs: 10, leaseSeconds: 60 });
    const r1 = await a.acquire();
    expect(r1).not.toBeNull();
    const t0 = Date.now();
    expect(await a.acquire()).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    expect(w.held.size).toBe(1);
    r1!();
    await tick();
    expect(w.held.size).toBe(0);
  });
  it("a slot freed while waiting is taken", async () => {
    const w = slots(1);
    const a = createSlotAdmission(w.rpc, { maxWaitMs: 1_000, pollMs: 5, leaseSeconds: 60 });
    const r1 = await a.acquire();
    const p = a.acquire();
    setTimeout(() => r1!(), 20);
    expect(await p).not.toBeNull();
  });
  it("a database error counts as busy (never as admitted)", async () => {
    const a = createSlotAdmission(async () => ({ data: null, error: { code: "PGRST202" } }), { maxWaitMs: 20, pollMs: 5, leaseSeconds: 60 });
    expect(await a.acquire()).toBeNull();
  });
  it("combined: refused by the shared slots → the local slot is given back", async () => {
    const local = createAdmission(1, 10);
    const shared = createSlotAdmission(async () => ({ data: null, error: null }), { maxWaitMs: 10, pollMs: 5, leaseSeconds: 60 });
    expect(await combineAdmissions(local, shared).acquire()).toBeNull();
    expect(local.state()).toEqual({ active: 0, waiting: 0 });
  });
});
