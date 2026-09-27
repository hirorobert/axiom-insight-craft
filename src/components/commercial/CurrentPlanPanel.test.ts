import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { CurrentPlanPanel } from "./CurrentPlanPanel";
import { PlanCatalogue } from "./PlanCatalogue";
import type { BillingSummary } from "@/hooks/useBillingSummary";
const base: BillingSummary = { hasBillingCustomer: true, planCode: "SOLO", licenceStatus: "ACTIVE", effectiveStart: "2026-01-01", effectiveEnd: null, entitlements: [], billingInterval: null, billingIntervalCount: null, scheduledEffectiveEnd: null, nextEffectiveStart: null, nextEffectiveEnd: null, nextBillingInterval: null, nextBillingIntervalCount: null };
const render = (node: ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node));
describe("plan presentation is read-only", () => {
  it("shows effective dates only when provided, never renewal", () => {
    const html = render(createElement(CurrentPlanPanel, { billing: base, loading: false, error: false, capacity: { capacity: 1, used: 1, determined: true, planCode: "SOLO" } }));
    expect(html).toContain("Effective from");
    expect(html).not.toContain("Effective through");
    expect(html).not.toMatch(/renewal|deactivation/i);
  });
  it("shows archive-only status with plans but no setup", () => {
    const html = render(createElement(CurrentPlanPanel, { billing: { ...base, licenceStatus: "EXPIRED" }, loading: false, error: false, archiveOnly: true }));
    expect(html).toContain("Archive-only");
    expect(html).toContain("View plans");
    expect(html).toContain("remain readable");
  });
  it("fails closed on loading and error", () => {
    expect(render(createElement(CurrentPlanPanel, { billing: null, loading: true, error: false }))).toContain("Loading plan");
    expect(render(createElement(CurrentPlanPanel, { billing: null, loading: false, error: true, onRetry: () => {} }))).toContain("We couldn’t load your plan");
  });
  it("catalogue uses matrix and never claims saved selection or activation", () => {
    const html = render(createElement(PlanCatalogue));
    expect(html).toContain("Close Assurance");
    expect(html).toContain("Choose Solo");
    expect(html).not.toMatch(/selected plan has been saved|deactivation/i);
  });
});
