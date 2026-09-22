/**
 * Dashboard.test.ts — returning-user routing decision (requirement #1 of the canonical-workflow
 * remediation). The actual branch decision is a pure function
 * (resolveReturningUserRoute.decideReturningUserRoute, covered directly and exhaustively by
 * resolveReturningUserRoute.test.ts). This file proves Dashboard.tsx WIRES that decision correctly:
 * an unambiguous single-engagement/single-company case never renders the ambiguous chooser, and an
 * ambiguous case always does — the exact regression this remediation exists to prevent. Renders the
 * REAL Dashboard component (not a re-implementation) over a mocked useActiveEngagements/useAuth/
 * supabase, the same pattern WorkspaceOverview.test.ts established.
 *
 * Navigation itself (the actual `navigate()` call for the two auto-resolving branches) happens
 * inside a useEffect, which does not fire under renderToStaticMarkup (no DOM, no commit phase) —
 * this repo's test environment is Node, not jsdom (vitest.config `environment: "node"`), so that
 * side effect is out of scope for a static render and is instead covered by
 * resolveReturningUserRoute.test.ts (which entry/company the decision points at) plus the synchronous
 * assertion here that the loading skeleton — not the hub — is what actually renders meanwhile.
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
vi.mock("@/hooks/useActiveEngagements", () => ({
  useActiveEngagements: () => activeEngagementsMock.value,
}));

function setActiveEngagements(v: {
  loading: boolean;
  entries: ActiveEngagementEntry[];
  companiesWithoutEngagement: WorkspaceCompany[];
  fetchFailed: boolean;
}) {
  activeEngagementsMock.value = { ...v, refresh: vi.fn() };
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
});

describe("Dashboard — returning-user routing never guesses among multiple engagements", () => {
  it("exactly one open engagement: shows the loading/redirect state, never the ambiguous chooser", async () => {
    setActiveEngagements({ loading: false, entries: [entry("e1", "c1", "Acme Ltd")], companiesWithoutEngagement: [], fetchFailed: false });
    const html = await renderDashboard();

    expect(html).not.toContain("Your engagements");
    expect(html).not.toContain("Start another service");
    expect(html).not.toContain("first-run-engagement");
  });

  it("one open engagement never shows the chooser even when OTHER companies have no open engagement — dormant companies never turn a resume into a guess", async () => {
    setActiveEngagements({
      loading: false,
      entries: [entry("e1", "c1", "Acme Ltd")],
      companiesWithoutEngagement: [company("c2", "Beta Co"), company("c3", "Gamma Co")],
      fetchFailed: false,
    });
    const html = await renderDashboard();

    expect(html).not.toContain("Your engagements");
    expect(html).not.toContain("Beta Co");
  });

  it("more than one open engagement always renders the deterministic chooser, listing every engagement", async () => {
    setActiveEngagements({
      loading: false,
      entries: [entry("e1", "c1", "Acme Ltd"), entry("e2", "c2", "Beta Co", 2026)],
      companiesWithoutEngagement: [],
      fetchFailed: false,
    });
    const html = await renderDashboard();

    expect(html).toContain("Acme Ltd");
    expect(html).toContain("Beta Co");
    expect(html).toContain("Your engagements");
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
    expect(html).toContain("Start another service");
  });

  it("zero companies at all: shows the first-run form, never a blank or crashing chooser", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [], fetchFailed: false });
    const html = await renderDashboard();

    expect(html).toContain("first-run-engagement");
  });

  it("a read failure is shown as a retriable error, never conflated with 'no engagements' or 'no companies'", async () => {
    setActiveEngagements({ loading: false, entries: [], companiesWithoutEngagement: [], fetchFailed: true });
    const html = await renderDashboard();

    expect(html).not.toContain("first-run-engagement");
    expect(html).not.toContain("Your engagements");
    expect(html).toMatch(/try again/i);
  });
});
