import { describe, expect, it, vi } from "vitest";
import { addTrialBalanceReview, partitionEngagements, singleFlight, ADD_REVIEW_REASON } from "./unavailableService";
import { decideReturningUserRoute } from "./resolveReturningUserRoute";
import type { EngagementCapability } from "./mandate";

const eng = (id: string, caps: EngagementCapability[]) => ({ engagementId: id, companyId: `c-${id}`, companyName: `Co ${id}`, periodYear: 2025, capabilities: caps });

describe("partitionEngagements", () => {
  it("withheld-only engagement is unavailable (still listed), never visible", () => {
    const r = partitionEngagements([eng("a", ["TAX_COMPUTATION"])]);
    expect(r.visible).toEqual([]);
    expect(r.unavailable).toEqual([{ engagementId: "a", companyId: "c-a", companyName: "Co a", periodYear: 2025 }]);
  });
  it("mixed visible/withheld capabilities stays a normal visible engagement", () => {
    const r = partitionEngagements([eng("b", ["TAX_COMPUTATION", "FINANCIAL_STATEMENTS"])]);
    expect(r.visible.map((e) => e.engagementId)).toEqual(["b"]);
    expect(r.unavailable).toEqual([]);
  });
  it("an engagement with no service declared yet is not unavailable (it needs its launchpad)", () => {
    expect(partitionEngagements([eng("c", [])]).unavailable).toEqual([]);
  });
  it("a withheld-only engagement keeps the account on the hub, never first run", () => {
    expect(decideReturningUserRoute([], [], [], 1)).toEqual({ kind: "chooser" });
  });
});

const client = (res: { data?: unknown; error: { code?: string; message?: string } | null } | Error) => ({
  rpc: vi.fn(async () => { if (res instanceof Error) throw res; return { data: res.data ?? null, error: res.error }; }),
});

describe("addTrialBalanceReview — explicit grant on the existing engagement only", () => {
  it("calls the existing authorized command with FINANCIAL_STATEMENTS on the same engagement", async () => {
    const c = client({ data: "id", error: null });
    expect(await addTrialBalanceReview(c, "e1")).toEqual({ ok: true });
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith("grant_engagement_capability", { p_engagement_id: "e1", p_capability: "FINANCIAL_STATEMENTS", p_reason: ADD_REVIEW_REASON });
    expect(c.rpc).not.toHaveBeenCalledWith("open_engagement_with_scope", expect.anything());
  });
  it("a repeated click after success (already granted) is success, not an error", async () => {
    expect(await addTrialBalanceReview(client({ error: { code: "23001", message: "Capability FINANCIAL_STATEMENTS is already part of this engagement." } }), "e1")).toEqual({ ok: true });
  });
  it("no plan → PLAN_REQUIRED", async () => {
    expect(await addTrialBalanceReview(client({ error: { code: "PT402" } }), "e1")).toMatchObject({ ok: false, kind: "PLAN_REQUIRED" });
  });
  it("insufficient permission → NOT_AUTHORISED", async () => {
    expect(await addTrialBalanceReview(client({ error: { code: "42501" } }), "e1")).toMatchObject({ ok: false, kind: "NOT_AUTHORISED" });
  });
  it("service refused by the server → UNAVAILABLE", async () => {
    expect(await addTrialBalanceReview(client({ error: { code: "PT422" } }), "e1")).toMatchObject({ ok: false, kind: "UNAVAILABLE" });
  });
  it("network failure → UNKNOWN, never thrown", async () => {
    expect(await addTrialBalanceReview(client(new Error("offline")), "e1")).toMatchObject({ ok: false, kind: "UNKNOWN" });
  });
});

describe("singleFlight — repeated clicks and failed attempts", () => {
  it("repeated clicks while in flight send exactly one request", async () => {
    let release!: () => void;
    const fn = vi.fn(() => new Promise<string>((r) => { release = () => r("done"); }));
    const go = singleFlight(fn);
    const first = go();
    expect(await go()).toBeNull();
    expect(await go()).toBeNull();
    release();
    expect(await first).toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("a failed attempt releases the guard so a retry is possible", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("ok");
    const go = singleFlight(fn);
    await expect(go()).rejects.toThrow("x");
    expect(await go()).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
