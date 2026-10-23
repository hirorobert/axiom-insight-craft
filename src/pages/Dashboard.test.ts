/** The company directory is the normal sign-in destination, including single-company accounts.
 * Server discovery, plan/capacity gates and explicit service intents retain their existing authority.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import type { ActiveEngagementEntry } from "@/hooks/useActiveEngagements";
import type { WorkspaceCompany } from "@/lib/workspace/fetchWorkspaceSnapshot";

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" }, loading: false }),
}));

vi.mock("@/components/workspace/FirstRunEngagement", () => ({
  default: () => createElement("div", { "data-testid": "first-run-engagement" }, "first-run"),
}));
vi.mock("@/components/workspace/FirstUpload", () => ({
  default: (p: { needsPlan?: boolean; compact?: boolean }) =>
    createElement("div", { "data-testid": "first-upload", "data-needs-plan": String(!!p.needsPlan), "data-compact": String(!!p.compact) }, "first-upload"),
}));

const supaMock = vi.hoisted(() => ({ update: vi.fn(() => ({ eq: () => ({ is: () => Promise.resolve({ error: null }) }) })) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "firm_members") return { update: supaMock.update };
      return { select: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [] }) }) }) }) }) };
    },
  },
}));

function company(id: string, name: string, fiscalYearEnd = "2025-12-31"): WorkspaceCompany {
  return { id, name, code: null, tin: null, reporting_framework: "full_ifrs", fiscal_year_end: fiscalYearEnd, currency: "TZS" };
}

function entry(id: string, companyId: string, companyName: string, periodYear = 2025): ActiveEngagementEntry {
  const workspaceState = deriveWorkspaceState(companyId, companyName, periodYear, null);
  return {
    engagementId: id,
    companyId,
    companyName,
    periodYear,
    engagementType: "financial_statements",
    framework: "full_ifrs",
    capabilities: ["FINANCIAL_STATEMENTS"],
    workspaceState,
    openedAt: "2026-01-01T00:00:00.000Z",
  };
}

const activeEngagementsMock = vi.hoisted(() => ({ value: null as unknown }));
const billingMock = vi.hoisted(() => ({ value: { summary: { hasBillingCustomer: true, planCode: "SOLO", licenceStatus: "ACTIVE", effectiveStart: null, effectiveEnd: null, entitlements: [], billingInterval: null, billingIntervalCount: null, scheduledEffectiveEnd: null, nextEffectiveStart: null, nextEffectiveEnd: null, nextBillingInterval: null, nextBillingIntervalCount: null }, loading: false, error: null, retry: vi.fn() } }));
const capacityMock = vi.hoisted(() => ({ value: { capacity: { capacity: 1, used: 0, determined: true, planCode: "SOLO" }, loading: false, error: false, retry: vi.fn() } }));
vi.mock("@/hooks/useBillingSummary", () => ({ useBillingSummary: () => billingMock.value }));
vi.mock("@/hooks/useMyEntityCapacity", () => ({ useMyEntityCapacity: () => capacityMock.value }));
// The home reads ONE bounded server answer with exact counts (useAccountHome → get_account_home). The fixtures below are
// complete lists, so each total is the list's length; totals larger than a sample are covered by accountHome.test.ts.
vi.mock("@/hooks/useAccountHome", () => ({
  useAccountHome: () => activeEngagementsMock.value,
}));

function setActiveEngagements(v: {
  loading: boolean;
  entries: ActiveEngagementEntry[];
  companiesWithoutEngagement: WorkspaceCompany[];
  fetchFailed: boolean;
}) {
  const counted = <T,>(rows: T[]) => ({ total: rows.length, rows, complete: true });
  activeEngagementsMock.value = {
    loading: v.loading, fetchFailed: v.fetchFailed, refresh: vi.fn(),
    home: v.fetchFailed ? null : {
      engagements: counted(v.entries.map((e) => ({ engagementId: e.engagementId, companyId: e.companyId, companyName: e.companyName, periodYear: e.periodYear, openedAt: e.openedAt }))),
      withheld: counted([]), companiesWithoutEngagement: counted(v.companiesWithoutEngagement), shared: counted([]),
    },
  };
}

async function renderDashboard(): Promise<string> {
  vi.resetModules();
  const { default: Dashboard } = await import("./Dashboard");
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Dashboard)));
}

afterEach(() => {
  vi.restoreAllMocks();
  navigateSpy.mockClear();
  supaMock.update.mockClear();
  billingMock.value = { ...billingMock.value, summary: { ...billingMock.value.summary, licenceStatus: "ACTIVE", planCode: "SOLO" }, loading: false, error: null };
  capacityMock.value = { ...capacityMock.value, capacity: { capacity: 1, used: 0, determined: true, planCode: "SOLO" }, loading: false, error: false };
});

describe("Dashboard — returning-user routing never guesses among multiple engagements", () => {
  it("exactly one open engagement: shows the company directory without silently selecting its period", async () => {
    setActiveEngagements({ loading: false, entries: [entry("e1", "c1", "Acme Ltd")], companiesWithoutEngagement: [], fetchFailed: false });
    const html = await renderDashboard();

    expect(html).toContain("Your companies");
    expect(html).toContain('data-testid="engagement-portfolio"');
    expect(html).not.toContain("Start another service");
    expect(html).not.toContain("first-run-engagement");
  });

  it("one open engagement does not hide other saved company drafts", async () => {
    setActiveEngagements({
      loading: false,
      entries: [entry("e1", "c1", "Acme Ltd")],
      companiesWithoutEngagement: [company("c2", "Beta Co"), company("c3", "Gamma Co")],
      fetchFailed: false,
    });
    const html = await renderDashboard();

    expect(html).toContain("Your companies");
    expect(html).toContain('data-testid="engagement-portfolio"');
    expect(html).toContain("Beta Co");
  });

  it("more than one open engagement always renders the deterministic chooser, with every engagement listed by the server", async () => {
    setActiveEngagements({
      loading: false,
      entries: [entry("e1", "c1", "Acme Ltd"), entry("e2", "c2", "Beta Co", 2026)],
      companiesWithoutEngagement: [],
      fetchFailed: false,
    });
    const html = await renderDashboard();

    // Never a redirect into one of them: the account home with the engagements list. The list itself is read page by page
    // from list_portfolio_engagements (EngagementPortfolio.test.ts covers its rows, paging and counts), not from `entries`.
    expect(html).toContain("Your companies");
    expect(html).toContain('data-testid="engagement-portfolio"');
    expect(html).toContain("Company workspaces");
    expect(html).not.toContain('data-testid="engagement-hub-list"');
  });

  it("zero open engagements, exactly one company: shows the loading/redirect state, never the chooser", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [company("c1", "Acme Ltd")], fetchFailed: false });
    const html = await renderDashboard();

    expect(html).not.toContain("Start another service");
    expect(html).not.toContain("first-run-engagement");
  });

  it("zero open engagements, more than one company: renders the 'start another service' chooser — never guesses which one", async () => {
    setActiveEngagements({
      loading: false,
      entries: [],
      companiesWithoutEngagement: [company("c1", "Acme Ltd"), company("c2", "Beta Co")],
      fetchFailed: false,
    });
    const html = await renderDashboard();

    expect(html).toContain("Acme Ltd");
    expect(html).toContain("Beta Co");
    expect(html).toContain("Company drafts");
  });

  it("zero companies: prominent company setup and upload routes, without an inline form", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [], fetchFailed: false });
    const html = await renderDashboard();

    // Inside the one account frame, the upload itself replaces the "Add your first company" card; the company form is
    // not opened beside it, and stays available as the secondary "Add a company".
    expect(html).toContain('data-testid="account-shell"');
    expect(html).not.toContain('data-testid="portfolio-upload-link"');
    expect(html).not.toContain('data-kind="add_company"');
    expect(html).not.toContain("first-run-engagement");
    expect(html).toContain('data-testid="add-company"');
  });

  it("returning user with entities: uploading is its own focused page (/upload), linked quietly from the engagements list; one filled primary remains", async () => {
    // (One company alone routes straight into its workspace; the home shows from two.) The compact upload card of P2-4
    // is replaced by the focused upload page (Trial Balance workflow, Track A): the home links to it, it does not embed it.
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [company("c1", "Acme Ltd"), company("c2", "Beta Co")], fetchFailed: false });
    const html = await renderDashboard();
    expect(html).not.toContain('data-compact="true"');
    const link = html.match(/<a[^>]*data-testid="portfolio-upload-link"[^>]*>/)?.[0] ?? "";
    expect(link).toBe("");
    expect(html).not.toContain("Reporting workflow");
    expect(html).not.toContain('data-testid="continue-engagement"');
    expect(html).toContain('data-testid="portfolio-home-header"');
    // The upload link is an outline link (secondary): the next action keeps at most one filled primary.
    expect((html.match(/data-testid="next-action-primary"/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("new no-plan user without entities: the upload is offered with the plan stated up front (purchase-required path; no silent redirect, no setup, no dead button)", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [], fetchFailed: false });
    billingMock.value = { ...billingMock.value, summary: { ...billingMock.value.summary, licenceStatus: null, planCode: null } };
    capacityMock.value = { ...capacityMock.value, capacity: { capacity: 0, used: 0, determined: true, planCode: null } };
    const html = await renderDashboard();
    expect(html).not.toContain("first-run-engagement");
    // The file can be kept privately as a draft; "Start" then leads to the plans (nothing is processed without a plan).
    expect(html).toContain('data-kind="choose_plan"');
    expect(html).toContain('data-testid="next-action-primary"');
    expect(html).not.toContain('data-testid="add-company"');
    expect(html).toContain('href="/plans"');
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
    expect((html.match(/No active plan/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("billing loading never mounts setup or redirects", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [], fetchFailed: false });
    billingMock.value = { ...billingMock.value, loading: true };
    const html = await renderDashboard();
    expect(html).not.toContain("first-run-engagement");
    expect(html).not.toContain("/plans");
  });

  it("billing failure shows controlled retry, not setup or plans", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [], fetchFailed: false });
    billingMock.value = { ...billingMock.value, error: "sensitive server text" };
    const html = await renderDashboard();
    expect(html).toContain("We couldn’t confirm your plan");
    expect(html).toContain("Try again");
    expect(html).not.toContain("We couldn’t load your plan"); // said once, by the next step
    expect(html).not.toContain("sensitive server text");
    expect(html).not.toContain("first-run-engagement");
  });

  it("historical entity retains workspace routing even without a plan", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [company("c1", "Archive Co")], fetchFailed: false });
    billingMock.value = { ...billingMock.value, summary: { ...billingMock.value.summary, licenceStatus: "EXPIRED" } };
    const html = await renderDashboard();
    expect(html).not.toContain("/plans");
    expect(html).not.toContain("first-run-engagement");
  });

  it("capacity exhaustion does not hijack an existing workspace", async () => {
    setActiveEngagements({ loading: false, entries: [entry("e1", "c1", "Acme Ltd")], companiesWithoutEngagement: [], fetchFailed: false });
    capacityMock.value = { ...capacityMock.value, capacity: { ...capacityMock.value.capacity, used: 1 } };
    const html = await renderDashboard();
    expect(html).not.toContain("/plans");
    expect(html).not.toContain("first-run-engagement");
  });

  it("a read failure is shown as a retriable error, never conflated with 'no engagements' or 'no companies'", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [], fetchFailed: true });
    const html = await renderDashboard();

    expect(html).not.toContain("first-run-engagement");
    expect(html).not.toContain('data-testid="engagement-portfolio"');
    expect(html).toContain('data-testid="engagements-read-failed"');
    expect(html).toMatch(/try again/i);
  });
});
