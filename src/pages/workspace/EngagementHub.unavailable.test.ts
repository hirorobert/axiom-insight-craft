import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import EngagementHub, { type AccountHome } from "./EngagementHub";
import type { UnavailableServiceEngagement } from "@/lib/workspace/unavailableService";

const account: AccountHome = { billing: null, billingLoading: false, billingError: false, capacity: null, capacityLoading: false, capacityError: false, onRetry: () => {}, onSignOut: () => {} };
const U: UnavailableServiceEngagement = { engagementId: "e1", companyId: "c1", companyName: "Arusha Dc", periodYear: 2025 };
const company = { id: "c2", name: "Other Co" } as never;
const shared = { id: "s1", name: "Shared Co", capabilities: ["manage_source_files"], fiscal_year_end: null, reporting_framework: null, currency: null, created_at: null } as never;

type Props = Parameters<typeof EngagementHub>[0];
const html = (p: Partial<Props>) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(EngagementHub, { entries: [], companiesWithoutEngagement: [], onResume: () => {}, onStartService: () => {}, account, ...p })));

const SOLO = { hasBillingCustomer: true, planCode: "SOLO", licenceStatus: "ACTIVE", effectiveStart: null, effectiveEnd: null, entitlements: [], billingInterval: null, billingIntervalCount: null, scheduledEffectiveEnd: null, nextEffectiveStart: null, nextEffectiveEnd: null, nextBillingInterval: null, nextBillingIntervalCount: null } as const;
const withPlan: AccountHome = { ...account, billing: SOLO as never, capacity: { capacity: 1, used: 1, determined: true, planCode: "SOLO" } };
const noPlan: AccountHome = { ...account, billing: { ...SOLO, planCode: null, licenceStatus: "EXPIRED" } as never, capacity: { capacity: 0, used: 1, determined: true, planCode: null } };
const primaries = (h: string) => (h.match(/data-testid="next-action-primary"/g) ?? []).length;

describe("EngagementHub — one primary next action, every instruction actionable", () => {
  it("withheld-only with a plan and permission: lists the company and makes starting the review the one primary action", () => {
    const h = html({ account: withPlan, unavailableEngagements: [U], onAddTrialBalanceReview: async () => ({ ok: true }), reviewGates: { c1: { state: "allowed" } } });
    expect(h).toContain("Arusha Dc");
    expect(h).toContain("Your existing service is currently unavailable");
    expect(h).toContain('data-kind="start_review"');
    expect(h).toContain('data-testid="add-review-e1"');
    expect(primaries(h)).toBe(1);
    expect(h).not.toMatch(/archived/i);
  });
  it("the screenshot case (withheld engagement, no plan): one 'choose a plan' step, no disabled start button, 'No active plan' said at most once", () => {
    const h = html({ account: noPlan, unavailableEngagements: [U], onAddTrialBalanceReview: async () => ({ ok: true }), reviewGates: { c1: { state: "blocked", reason: "This company's account has no current plan, so new work can't start." } } });
    expect(h).toContain('data-kind="choose_plan"');
    expect(h).toContain("Choose a plan to start new work");
    expect(h).toMatch(/data-testid="next-action-primary"[^>]*href="\/plans"|href="\/plans"[^>]*data-testid="next-action-primary"/);
    expect(h).not.toContain('data-testid="add-review-e1"');
    expect(h).not.toMatch(/<button[^>]*disabled=""/);
    expect(h).toContain("Starts once a plan is active.");
    expect((h.match(/No active plan/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(primaries(h)).toBe(1);
  });
  it("company with no engagement: the next step starts it, and its row is listed", () => {
    const h = html({ account: withPlan, companiesWithoutEngagement: [company] });
    expect(h).toContain('data-kind="start_service"');
    expect(h).toContain('data-testid="start-service-c2"');
  });
  it("shared workspace only: the next step opens it", () => {
    const h = html({ account: withPlan, sharedWorkspaces: [shared], onOpenShared: () => {} });
    expect(h).toContain('data-kind="open_shared"');
    expect(h).toContain('data-testid="open-shared-s1"');
  });
  it("nothing at all, room for a company: 'Add a company' is offered directly (the existing create_entity form)", () => {
    const h = html({ account: { ...withPlan, capacity: { capacity: 1, used: 0, determined: true, planCode: "SOLO" }, onCompanyCreated: () => {} } });
    expect(h).toContain('data-kind="add_company"');
    expect(h).toContain('data-testid="add-company"');
    expect(h).toContain('data-testid="manage-companies"');
  });
  it("without a creation handler the creation button is never offered (nothing that cannot work)", () => {
    const h = html({ account: { ...withPlan, capacity: { capacity: 1, used: 0, determined: true, planCode: "SOLO" } } });
    expect(h).not.toContain('data-testid="add-company"');
    expect(h).not.toContain('data-testid="next-action-primary"');
  });
});

describe("EngagementHub — permission-aware row action (never a disabled button)", () => {
  const add = async () => ({ ok: true as const });
  it("no access answer yet → the row says 'checking' and offers no action (loading never implies permission)", () => {
    const h = html({ unavailableEngagements: [U], onAddTrialBalanceReview: add });
    expect(h).toContain("Arusha Dc");
    expect(h).not.toContain('data-testid="add-review-e1"');
    expect(h).toMatch(/data-testid="review-gate-e1"[^>]*data-gate="checking"/);
    expect(h).toContain("Checking your access");
  });
  it("blocked (no permission) → the row states the reason; no button", () => {
    const h = html({ unavailableEngagements: [U], onAddTrialBalanceReview: add, reviewGates: { c1: { state: "blocked", reason: "Your access doesn't include starting services for this company. Ask the workspace owner." } } });
    expect(h).not.toContain('data-testid="add-review-e1"');
    expect(h).toContain('data-testid="review-gate-e1"');
    expect(h).toContain("Ask the workspace owner");
  });
  it("allowed → the action is enabled, no reason line", () => {
    const h = html({ unavailableEngagements: [U], onAddTrialBalanceReview: add, reviewGates: { c1: { state: "allowed" } } });
    expect(h).toMatch(/<button(?![^>]*disabled="")[^>]*data-testid="add-review-e1"[^>]*data-gate="allowed"/);
    expect(h).not.toContain('data-testid="review-gate-e1"');
  });
});

describe("EngagementHub — action wiring", () => {
  it("without an add handler no button is rendered (nothing that cannot work is offered)", () => {
    expect(html({ unavailableEngagements: [U] })).not.toContain('data-testid="add-review-e1"');
  });
});
