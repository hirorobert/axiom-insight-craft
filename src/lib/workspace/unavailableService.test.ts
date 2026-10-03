import { describe, expect, it, vi } from "vitest";
import {
  addTrialBalanceReview, partitionEngagements, reviewActionGate, singleFlight, trialBalanceReviewPath, ADD_REVIEW_REASON, GATE_COPY,
} from "./unavailableService";
import { decideReturningUserRoute } from "./resolveReturningUserRoute";
import type { EngagementCapability } from "./mandate";
import type { MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";

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
  it("Resume path is Trial balance review (Prepare) for the SAME entity and period", () => {
    expect(trialBalanceReviewPath({ companyId: "c1", periodYear: 2025 })).toBe("/workspace/c1/2025/prepare");
  });
});

const caps = (p: Partial<MyWorkspaceCapabilities>): MyWorkspaceCapabilities => ({ access: true, held: ["review_close"], allowed: ["review_close"], hasCurrentPlan: true, manageBilling: true, ...p });

describe("reviewActionGate — loading never implies permission; unknown is not permitted", () => {
  it("loading → checking (disabled)", () => expect(reviewActionGate(true, caps({}))).toEqual({ state: "checking", reason: GATE_COPY.checking }));
  it("read failed / malformed → blocked", () => expect(reviewActionGate(false, null)).toEqual({ state: "blocked", reason: GATE_COPY.unknown }));
  it("no workspace access → blocked", () => expect(reviewActionGate(false, caps({ access: false, held: [], allowed: [] }))).toEqual({ state: "blocked", reason: GATE_COPY.noAccess }));
  it("insufficient permission (no review_close) → blocked", () => expect(reviewActionGate(false, caps({ held: ["prepare_close"], allowed: ["prepare_close"] }))).toEqual({ state: "blocked", reason: GATE_COPY.noPermission }));
  it("no current plan → blocked", () => expect(reviewActionGate(false, caps({ hasCurrentPlan: false, allowed: [] }))).toEqual({ state: "blocked", reason: GATE_COPY.noPlan }));
  it("plan unknown (null) → blocked, never assumed", () => expect(reviewActionGate(false, caps({ hasCurrentPlan: null }))).toMatchObject({ state: "blocked" }));
  it("held + plan + allowed → allowed", () => expect(reviewActionGate(false, caps({}))).toEqual({ state: "allowed" }));
});

type R = { data?: unknown; error: { code?: string; message?: string } | null };
const FOLD_FS = { data: [{ capability: "FINANCIAL_STATEMENTS", granted: true }, { capability: "TAX_COMPUTATION", granted: true }], error: null };
const FOLD_TAX = { data: [{ capability: "TAX_COMPUTATION", granted: true }], error: null };
const client = (grant: R | Error, fold: R = FOLD_FS) => ({
  rpc: vi.fn(async (fn: string) => {
    if (fn === "fold_engagement_mandate") return { data: fold.data ?? null, error: fold.error };
    if (grant instanceof Error) throw grant;
    return { data: grant.data ?? null, error: grant.error };
  }),
});

describe("addTrialBalanceReview — success only when the authority confirms it", () => {
  it("calls the existing command on the same engagement, then re-reads the mandate", async () => {
    const c = client({ data: "id", error: null });
    expect(await addTrialBalanceReview(c, "e1")).toEqual({ ok: true });
    expect(c.rpc.mock.calls).toEqual([
      ["grant_engagement_capability", { p_engagement_id: "e1", p_capability: "FINANCIAL_STATEMENTS", p_reason: ADD_REVIEW_REASON }],
      ["fold_engagement_mandate", { p_engagement_id: "e1" }],
    ]);
  });
  it("already granted (23001) + authority confirms → success", async () => {
    expect(await addTrialBalanceReview(client({ error: { code: "23001" } }), "e1")).toEqual({ ok: true });
  });
  it("already granted (23001) but authority does NOT confirm → not success", async () => {
    expect(await addTrialBalanceReview(client({ error: { code: "23001" } }, FOLD_TAX), "e1")).toMatchObject({ ok: false, kind: "UNCONFIRMED" });
  });
  it("success response but confirmation read fails → not success", async () => {
    expect(await addTrialBalanceReview(client({ error: null }, { error: { code: "XX000" } }), "e1")).toMatchObject({ ok: false, kind: "UNCONFIRMED" });
  });
  it("an 'already part' MESSAGE with another code is not treated as success", async () => {
    const c = client({ error: { code: "XX000", message: "Capability is already part of this engagement" } });
    expect(await addTrialBalanceReview(c, "e1")).toMatchObject({ ok: false, kind: "UNKNOWN" });
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([["PT402", "PLAN_REQUIRED"], ["42501", "NOT_AUTHORISED"], ["PT422", "UNAVAILABLE"], ["P0001", "UNKNOWN"]])("%s → %s, never success, no confirmation read", async (code, kind) => {
    const c = client({ error: { code } });
    expect(await addTrialBalanceReview(c, "e1")).toMatchObject({ ok: false, kind });
    expect(c.rpc).toHaveBeenCalledTimes(1);
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
