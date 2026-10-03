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

describe("EngagementHub — every empty-state instruction has a visible action", () => {
  it("withheld-only: lists the company, explains unavailability, offers Trial balance review", () => {
    const h = html({ unavailableEngagements: [U], onAddTrialBalanceReview: async () => ({ ok: true }) });
    expect(h).toContain("Arusha Dc");
    expect(h).toContain("Your existing service is currently unavailable");
    expect(h).toContain('data-testid="add-review-e1"');
    expect(h).toContain("Start Trial balance review");
    expect(h).not.toMatch(/archived/i);
    expect(h).not.toContain("No open engagements");
  });
  it("company with no engagement: the 'below' promise has a company row below it", () => {
    const h = html({ companiesWithoutEngagement: [company] });
    expect(h).toContain("Start a service for a company below");
    expect(h).toContain('data-testid="start-service-c2"');
  });
  it("shared workspace only: points to the shared row that exists", () => {
    const h = html({ sharedWorkspaces: [shared], onOpenShared: () => {} });
    expect(h).toContain("Open a workspace shared with you below");
    expect(h).toContain('data-testid="open-shared-s1"');
    expect(h).not.toContain("Start a service for a company below");
  });
  it("nothing at all: points to the company link that exists", () => {
    const h = html({});
    expect(h).toContain("Add a company below to begin");
    expect(h).toContain('data-testid="manage-companies"');
    expect(h).not.toContain("Start a service for a company below");
  });
});

describe("EngagementHub — action wiring", () => {
  it("without an add handler no button is rendered (nothing that cannot work is offered)", () => {
    expect(html({ unavailableEngagements: [U] })).not.toContain('data-testid="add-review-e1"');
  });
});
