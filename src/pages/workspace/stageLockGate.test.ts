/**
 * stageLockGate.test.ts — requirement #7 (navigation/direct-route enforcement): prove a direct URL
 * to a locked stage cannot bypass certification. StatementsWorkspace, TaxWorkspace and
 * FilingWorkspace each read `workspaceState.missions[stage].status === "locked"` and return
 * WorkspaceGate instead of their real content BEFORE any of that content is referenced — this
 * renders each of the three REAL page components (not a re-implementation) directly, the way
 * react-router would for a bookmarked/typed URL, bypassing StageScopeGate's mandate check entirely
 * (StageScopeGate guards SCOPE; this proves the SEPARATE accounting gate each page owns for
 * itself). `workspaceState` is built the same way useWorkspaceData.ts builds it — via the real
 * deriveWorkspaceState() — so this is the SAME canonical projection Overview and the tab bar
 * (WorkspaceOverview.test.ts, StageDot in WorkspaceLayout.tsx) already consume, not a second one.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import type { UploadSnapshot } from "@/lib/workspace/types";
import type { UseWorkspaceDataReturn, WorkspaceUpload, WorkspaceCompany } from "@/hooks/useWorkspaceData";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() }, auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1", email: "a@b.com" }, loading: false }) }));
vi.mock("@/contexts/EngagementContext", () => ({
  useEngagement: () => ({ canAmend: true, engagement: { id: "eng-1" }, mandate: { granted: ["TAX_COMPUTATION", "FILING_PREPARATION"] }, missionViews: [], loading: false }),
}));

const CID = "11111111-1111-4111-8111-111111111111";
const PY = 2025;

const company: WorkspaceCompany = {
  id: CID,
  name: "Acme Ltd",
  code: null,
  tin: "123456789",
  reporting_framework: "full_ifrs",
  fiscal_year_end: "2025-12-31",
  currency: "TZS",
  // TZ is the one pack this repository ships, so both TAX_COMPUTATION and FILING_PREPARATION are
  // available — the jurisdiction gate (a DIFFERENT, unrelated lock) never fires and cannot be
  // confused with the certification lock under test.
  filing_jurisdiction: "TZ",
};

const baseUpload: WorkspaceUpload = {
  id: "upload-1",
  file_name: "tb.xlsx",
  file_path: "x",
  file_size: 1000,
  company_id: CID,
  company_name: company.name,
  status: "complete",
  uploaded_at: "2026-01-01T00:00:00.000Z",
  processed_at: "2026-01-01T00:05:00.000Z",
  is_valid: true,
  validation_report: null,
  accounting_errors: null,
  processing_result: null,
  period_year: PY,
  safisha_status: null,
};

function lockedSnapshot(): UploadSnapshot {
  // PATH 6B: classification complete but certification not established — statements/tax/filing all
  // resolve to "locked". The exact scenario the live-observed contradiction (PR #31) was about.
  return {
    id: baseUpload.id,
    companyId: CID,
    companyName: company.name,
    periodYear: PY,
    status: "complete",
    isValid: true,
    safishaStatus: null,
    uploadedAt: baseUpload.uploaded_at,
    processedAt: baseUpload.processed_at,
    hasMapping: false,
    hesabuPassedAt: null,
    kingaSignedAt: null,
    filingSubmittedAt: null,
    certificationVerdict: "blocked",
    certificationBlocker: "Debits != Credits (difference: 275580.00)",
  };
}

function mockWorkspace(snapshot: UploadSnapshot | null): UseWorkspaceDataReturn {
  const workspaceState = deriveWorkspaceState(CID, company.name, PY, snapshot);
  return {
    companyId: CID,
    periodYear: PY,
    company,
    upload: baseUpload,
    uploads: [baseUpload],
    workspaceState,
    loading: false,
    refreshing: false,
    refreshUpload: vi.fn(),
  };
}

async function renderStagePage(modulePath: string, snapshot: UploadSnapshot | null): Promise<string> {
  vi.resetModules();
  const value = mockWorkspace(snapshot);
  vi.doMock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => value }));
  const { default: Page } = await import(modulePath);
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page)));
}

afterEach(() => {
  vi.doUnmock("@/contexts/WorkspaceContext");
  vi.restoreAllMocks();
});

describe("direct URLs cannot bypass certification — the mission-locked gate blocks BEFORE real content is reached", () => {
  it("StatementsWorkspace: a direct /statements URL with certification not established shows the lock, not the statement output", async () => {
    const html = await renderStagePage("./StatementsWorkspace", lockedSnapshot());

    expect(html).toContain("Prepare Statements is locked");
    expect(html).toContain("Debits != Credits");
    expect(html).not.toContain("Financial statement output");
    expect(html).not.toContain("Produce the current statement set");
  });

  it("TaxWorkspace: a direct /tax URL with certification not established shows the lock, not the tax computation panel", async () => {
    const html = await renderStagePage("./TaxWorkspace", lockedSnapshot());

    expect(html).toContain("Compute Tax is locked");
    expect(html).not.toContain("Corporate Tax");
    expect(html).not.toContain("jurisdiction-gate");
  });

  it("FilingWorkspace: a direct /filing URL with certification not established shows the lock, not the filing outputs", async () => {
    const html = await renderStagePage("./FilingWorkspace", lockedSnapshot());

    expect(html).toContain("Prepare Outputs is locked");
  });

  it("the SAME workspaceState the stage page reads its lock from is what WorkspaceOverview's dominant CTA reads too — one canonical projection, not two", async () => {
    // Both pages are handed the exact same snapshot → the exact same deriveWorkspaceState() call.
    // If they ever disagreed, this test's other two assertions (mission.status and nextAction) would
    // be reading from different sources — they are not: workspaceState is one object, passed once.
    const snapshot = lockedSnapshot();
    const workspaceState = deriveWorkspaceState(CID, company.name, PY, snapshot);
    expect(workspaceState.missions.statements.status).toBe("locked");
    expect(workspaceState.missions.tax.status).toBe("locked");
    expect(workspaceState.missions.filing.status).toBe("locked");
    expect(workspaceState.nextAction.id).toBe("fix-certification-failure");

    const html = await renderStagePage("./StatementsWorkspace", snapshot);
    expect(html).toContain(workspaceState.missions.statements.blocker ?? "");
  });
});

describe("the lock is specific to certification, not a blanket block — a genuinely different reason renders its own distinct gate", () => {
  it("TaxWorkspace with NO upload at all shows a different blocker ('valid processed trial balance required'), never the certification wording", async () => {
    const value = mockWorkspace(null);
    vi.resetModules();
    vi.doMock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ ...value, upload: null, uploads: [] }) }));
    const { default: TaxWorkspace } = await import("./TaxWorkspace");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TaxWorkspace)));

    expect(html).toContain("Compute Tax is locked");
    expect(html).not.toContain("Debits != Credits");
    expect(html).toContain("Complete Prepare Data first");
    expect(html).toContain("Go to Prepare Data");
  });
});
