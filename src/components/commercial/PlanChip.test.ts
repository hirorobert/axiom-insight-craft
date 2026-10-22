// @vitest-environment jsdom
/**
 * The header plan chip (owner decision 2026-10-20): "No plan · Choose a plan", "<Plan> plan", "Plan expired · Renew" — and
 * nothing at all while the state is unknown (NULL is not computed). Never "Free": there is no free plan.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingSummary } from "@/hooks/useBillingSummary";

const { hook } = vi.hoisted(() => ({ hook: { summary: null as unknown, loading: false, error: null as string | null } }));
vi.mock("@/hooks/useBillingSummary", () => ({ useBillingSummary: () => ({ ...hook, retry: () => undefined }) }));

import { PlanChip } from "./PlanChip";
import { planChipView } from "@/lib/commercial/purchaseJourney";

const base: BillingSummary = { hasBillingCustomer: true, planCode: "PRACTICE", licenceStatus: "ACTIVE", effectiveStart: "2026-01-01", effectiveEnd: null, entitlements: [], billingInterval: null, billingIntervalCount: null, scheduledEffectiveEnd: null, nextEffectiveStart: null, nextEffectiveEnd: null, nextBillingInterval: null, nextBillingIntervalCount: null };
const noPlan: BillingSummary = { ...base, planCode: null, licenceStatus: null };
const render = () => renderToStaticMarkup(h(MemoryRouter, null, h(PlanChip)));

beforeEach(() => { hook.summary = null; hook.loading = false; hook.error = null; });

describe("planChipView", () => {
  it("no plan: 'No plan · Choose a plan' to the plans page", () => {
    expect(planChipView(noPlan, false, null)).toEqual({ kind: "no_plan", label: "No plan", action: "Choose a plan", href: "/plans" });
    expect(planChipView({ ...base, licenceStatus: "CANCELLED" }, false, null).kind).toBe("no_plan");
  });
  it("a current plan (active or in grace) is named; never a link", () => {
    expect(planChipView(base, false, null)).toEqual({ kind: "current", label: "Practice plan" });
    expect(planChipView({ ...base, planCode: "SOLO", licenceStatus: "GRACE" }, false, null)).toEqual({ kind: "current", label: "Solo plan" });
  });
  it("expired: 'Plan expired · Renew'", () => {
    expect(planChipView({ ...base, licenceStatus: "EXPIRED" }, false, null)).toMatchObject({ kind: "expired", label: "Plan expired", action: "Renew", href: "/plans" });
  });
  it("unknown is never claimed: loading, a read error, no billing account (a team member), a pending or suspended licence, an unknown plan code", () => {
    expect(planChipView(base, true, null).kind).toBe("none");
    expect(planChipView(null, false, "failed").kind).toBe("none");
    expect(planChipView(base, false, "failed").kind).toBe("none");
    expect(planChipView(null, false, null).kind).toBe("none");
    expect(planChipView({ ...noPlan, hasBillingCustomer: false }, false, null).kind).toBe("none");
    expect(planChipView({ ...base, licenceStatus: "PENDING" }, false, null).kind).toBe("none");
    expect(planChipView({ ...base, licenceStatus: "SUSPENDED" }, false, null).kind).toBe("none");
    expect(planChipView({ ...base, planCode: "NOT_A_PLAN" }, false, null).kind).toBe("none");
  });
});

describe("PlanChip", () => {
  it("renders the no-plan chip as one link; never says Free", () => {
    hook.summary = noPlan;
    const html = render();
    expect(html).toContain('href="/plans"');
    expect(html).toMatch(/No plan.*·.*Choose a plan/);
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).not.toMatch(/free/i);
  });
  it("renders the current plan as plain text", () => {
    hook.summary = base;
    const html = render();
    expect(html).toContain("Practice plan");
    expect(html).not.toContain("<a ");
  });
  it("renders nothing while loading or after a failed read", () => {
    hook.summary = noPlan; hook.loading = true;
    expect(render()).toBe("");
    hook.loading = false; hook.error = "failed";
    expect(render()).toBe("");
  });
});
