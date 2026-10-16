/**
 * admission.test.ts — controlled admission for process-trial-balance (supabase/functions/_shared/admission.ts).
 * The real function under 4-way load at the account limit is exercised by scripts/e2e/draftJourney.mjs (CI).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAdmission, withAdmission } from "../../../supabase/functions/_shared/admission";

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

  it("with no wait (process-trial-balance: one check per isolate), a second request is refused at once and nothing is queued", async () => {
    const a = createAdmission(1, 0);
    const r1 = await a.acquire();
    const t0 = Date.now();
    expect(await a.acquire()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(20);
    expect(a.state()).toEqual({ active: 1, waiting: 0 });
    r1!();
    expect(await a.acquire()).not.toBeNull();
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

// Narrowed to what CI run 38904836096 DEMONSTRATED (a node: import is not banned as such):
//   1. the Edge Runtime (supabase-edge-runtime-1.77.4) refused to boot process-trial-balance — "The requested module
//      'node:process' does not provide an export named 'cpuUsage'" — so named imports from node:process are refused;
//   2. CI's Deno check has no node_modules ("Could not find @types/node"), so a node: import anywhere in the import graph
//      of a function CI type-checks fails that check — refused for exactly those graphs, read from ci.yml.
describe("edge functions boot and type-check as CI and the Edge Runtime require", () => {
  const REPO_ROOT = path.resolve(__dirname, "../../..");
  it("no named import from node:process anywhere under supabase/functions (the demonstrated boot failure)", () => {
    const root = path.join(REPO_ROOT, "supabase/functions");
    const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.(ts|mts|mjs)$/.test(f));
    const offenders = files.filter((f) => /import\s*\{[^}]*\}\s*from\s*["']node:process["']/.test(fs.readFileSync(path.join(root, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("no node: import in the import graph of any function CI type-checks with deno check (no @types/node there)", async () => {
    const { closureOf } = await import("../../../scripts/release/functionClosure.mjs");
    const ci = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const entries = [...new Set([...ci.matchAll(/deno check(?: --[^\s]+)* ([^\n]+)/g)].flatMap((m) => m[1].split(/\s+/)).filter((f) => /^supabase\/functions\/[^\s]+\/index\.ts$/.test(f)))];
    expect(entries.length).toBeGreaterThan(5);
    const offenders = entries.flatMap((e) => (closureOf(path.join(REPO_ROOT, e), REPO_ROOT).remote as string[]).filter((r) => r.startsWith("node:")).map((r) => `${e}: ${r}`));
    expect(offenders).toEqual([]);
  });
});
