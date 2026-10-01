import { describe, expect, it } from "vitest";
import { decideEmptyAccountScreen } from "./dashboardPlanDecision";
import type { BillingSummary } from "@/hooks/useBillingSummary";

const base: BillingSummary = { hasBillingCustomer: true, planCode: "SOLO", licenceStatus: "ACTIVE", effectiveStart: null, effectiveEnd: null, entitlements: [], billingInterval: null, billingIntervalCount: null, scheduledEffectiveEnd: null, nextEffectiveStart: null, nextEffectiveEnd: null, nextBillingInterval: null, nextBillingIntervalCount: null };
const capacity = { capacity: 1, used: 0, determined: true, planCode: "SOLO" };
describe("empty-account plan gate", () => {
  it("new no-plan account sees plans", () => expect(decideEmptyAccountScreen({ ...base, licenceStatus: null, planCode: null }, { ...capacity, capacity: 0 }, false)).toBe("plans"));
  it("active account with available capacity sees setup", () => expect(decideEmptyAccountScreen(base, capacity, false)).toBe("setup"));
  it("unknown usage never mounts setup", () => expect(decideEmptyAccountScreen(base, { ...capacity, used: null }, false)).toBe("unavailable"));
  it("capacity exhaustion never mounts setup", () => expect(decideEmptyAccountScreen(base, { ...capacity, used: 1 }, false)).toBe("unavailable"));
  it("by-agreement (undetermined) capacity on an active licence mounts setup, not a dead-end error", () => {
    const enterprise: BillingSummary = { ...base, planCode: "ENTERPRISE" };
    expect(decideEmptyAccountScreen(enterprise, { capacity: null, used: null, determined: false, planCode: "ENTERPRISE" }, false)).toBe("setup");
    expect(decideEmptyAccountScreen(enterprise, { capacity: null, used: 0, determined: false, planCode: "ENTERPRISE" }, false)).toBe("setup");
  });
  it("missing billing or capacity never assumes no plan", () => {
    expect(decideEmptyAccountScreen(null, capacity, false)).toBe("unavailable");
    expect(decideEmptyAccountScreen(base, null, false)).toBe("unavailable");
  });
  it("shared historical workspace is not redirected to plans", () => expect(decideEmptyAccountScreen({ ...base, licenceStatus: "EXPIRED" }, capacity, true)).toBe("shared"));
});
