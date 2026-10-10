import { describe, expect, it } from "vitest";
import { companyCreation, deriveAccountNextAction, type AccountNextActionInput } from "./accountNextAction";
import { GATE_COPY } from "./unavailableService";
import type { BillingSummary } from "@/hooks/useBillingSummary";

const plan: BillingSummary = { hasBillingCustomer: true, planCode: "SOLO", licenceStatus: "ACTIVE", effectiveStart: null, effectiveEnd: null, entitlements: [], billingInterval: null, billingIntervalCount: null, scheduledEffectiveEnd: null, nextEffectiveStart: null, nextEffectiveEnd: null, nextBillingInterval: null, nextBillingIntervalCount: null };
const noPlan: BillingSummary = { ...plan, planCode: null, licenceStatus: null };
const room = { capacity: 1, used: 0, determined: true, planCode: "SOLO" };
const base: AccountNextActionInput = {
  billing: { loading: false, error: false, summary: plan },
  capacity: { loading: false, error: false, answer: room },
  entries: [], unavailable: [], reviewGates: {}, companiesWithoutEngagement: [], sharedCount: 0,
};
const nbaa = { engagementId: "e1", companyId: "c1", companyName: "NBAA", periodYear: 2026 };
const kind = (p: Partial<AccountNextActionInput>) => deriveAccountNextAction({ ...base, ...p }).kind;

describe("deriveAccountNextAction — one primary action from authoritative reads", () => {
  it("a plan read in flight is 'checking'; a failed one is 'retry' — never assumed to be 'no plan'", () => {
    expect(kind({ billing: { loading: true, error: false, summary: null } })).toBe("checking");
    expect(kind({ billing: { loading: false, error: true, summary: null } })).toBe("retry");
    expect(kind({ billing: { loading: false, error: false, summary: null } })).toBe("retry");
  });
  it("fresh account without a plan: choose a plan (not a creation form, not a dead button)", () => {
    const a = deriveAccountNextAction({ ...base, billing: { loading: false, error: false, summary: noPlan }, capacity: { loading: false, error: false, answer: { capacity: 0, used: 0, determined: true, planCode: null } } });
    expect(a).toMatchObject({ kind: "choose_plan", title: "Choose a plan to begin" });
  });
  it("the screenshot case — a withheld engagement and no plan: choose a plan; records are kept", () => {
    const a = deriveAccountNextAction({ ...base, billing: { loading: false, error: false, summary: { ...noPlan, licenceStatus: "EXPIRED" } }, unavailable: [nbaa], reviewGates: { c1: { state: "blocked", reason: GATE_COPY.noPlan } } });
    expect(a.kind).toBe("choose_plan");
    expect(a).toMatchObject({ title: "Choose a plan to start new work" });
    expect("detail" in a && a.detail).toMatch(/kept and stay readable/);
  });
  it("no plan, only shared workspaces: open the shared workspace (its owner's plan governs it)", () => {
    expect(kind({ billing: { loading: false, error: false, summary: noPlan }, sharedCount: 1 })).toBe("open_shared");
  });
  it("with a plan: one engagement → resume; several → choose", () => {
    const e = { engagementId: "x", companyName: "Acme", periodYear: 2025 };
    expect(kind({ entries: [e] })).toBe("resume");
    expect(kind({ entries: [e, { ...e, engagementId: "y" }] })).toBe("choose_engagement");
  });
  it("with a plan and a withheld engagement: start review only where the server's gate allows it", () => {
    expect(kind({ unavailable: [nbaa], reviewGates: { c1: { state: "allowed" } } })).toBe("start_review");
    expect(kind({ unavailable: [nbaa], reviewGates: {} })).toBe("checking");
    expect(kind({ unavailable: [nbaa], reviewGates: { c1: { state: "blocked", reason: GATE_COPY.noPermission } } })).toBe("ask_owner");
  });
  it("companies without an engagement: one → start; several → choose", () => {
    expect(kind({ companiesWithoutEngagement: [{ id: "c", name: "C" }] })).toBe("start_service");
    expect(kind({ companiesWithoutEngagement: [{ id: "c", name: "C" }, { id: "d", name: "D" }] })).toBe("choose_company");
  });
  it("nothing yet, with a plan: add a company when capacity permits; otherwise say capacity is in use", () => {
    expect(kind({})).toBe("add_company");
    expect(kind({ capacity: { loading: false, error: false, answer: { ...room, used: 1 } } })).toBe("capacity_reached");
    expect(kind({ capacity: { loading: true, error: false, answer: null } })).toBe("checking");
    expect(kind({ capacity: { loading: false, error: true, answer: null } })).toBe("retry");
  });
});

describe("companyCreation — what the home may offer (create_entity stays the authority)", () => {
  const c = (b: BillingSummary | null, answer: typeof room | { capacity: number | null; used: number | null; determined: boolean; planCode: string | null } | null) =>
    companyCreation({ billing: { loading: false, error: false, summary: b }, capacity: { loading: false, error: false, answer } });
  it("active plan with room → allowed; full → capacity_reached; unknown usage → unknown", () => {
    expect(c(plan, room)).toBe("allowed");
    expect(c(plan, { ...room, used: 1 })).toBe("capacity_reached");
    expect(c(plan, { ...room, used: null })).toBe("unknown");
  });
  it("by-agreement (undetermined) capacity on an active licence → allowed; the server decides", () => {
    expect(c({ ...plan, planCode: "ENTERPRISE" }, { capacity: null, used: null, determined: false, planCode: "ENTERPRISE" })).toBe("allowed");
  });
  it("no plan → needs_plan; a missing read never assumes either way", () => {
    expect(c(noPlan, room)).toBe("needs_plan");
    expect(c(null, room)).toBe("unknown");
    expect(c(plan, null)).toBe("unknown");
    expect(companyCreation({ billing: { loading: true, error: false, summary: null }, capacity: { loading: false, error: false, answer: room } })).toBe("checking");
  });
});
