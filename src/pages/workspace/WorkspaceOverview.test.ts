/**
 * WorkspaceOverview.test.ts — root-cause regression coverage for the live-observed contradiction (2026-09-22):
 * Overview said "TB is valid — cross-validate the draft financial statements" while Prepare Data's own pre-flight
 * panel showed CHECKS FAILED (Debits != Credits) for the SAME upload. Renders the REAL WorkspaceOverview component
 * (not a re-implementation) with a workspaceState built the same way useWorkspaceData.ts now builds it — via
 * deriveWorkspaceState fed a certificationVerdict — over a mocked WorkspaceContext/EngagementContext so no Supabase
 * call is required.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import type { UploadSnapshot } from "@/lib/workspace/types";
import type { UseWorkspaceDataReturn, WorkspaceUpload, WorkspaceCompany } from "@/hooks/useWorkspaceData";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), functions: { invoke: vi.fn() }, auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));
vi.mock("@/hooks/useDataStart", () => ({
  useDataStart: () => ({ choice: "import", loading: false, saving: false, record: vi.fn(async () => true) }),
}));

const engagementValue = {
  engagement: { id: "eng-1" },
  mandate: { granted: ["FINANCIAL_STATEMENTS"] },
  authorities: [],
  events: [],
  canAmend: true,
  loading: false,
  refresh: vi.fn(),
  createEngagement: vi.fn(),
  grantCapability: vi.fn(),
  revokeCapability: vi.fn(),
  missionViews: [
    { stage: "prepare", visible: true, workflowStatus: "in_progress" },
    { stage: "reconcile", visible: true, workflowStatus: "not_applicable" },
    { stage: "statements", visible: true, workflowStatus: "locked" },
    { stage: "tax", visible: true, workflowStatus: "locked" },
    { stage: "compliance", visible: true, workflowStatus: "not_applicable" },
    { stage: "filing", visible: true, workflowStatus: "locked" },
    { stage: "monitor", visible: true, workflowStatus: "not_applicable" },
  ],
};
vi.mock("@/contexts/EngagementContext", () => ({ useEngagement: () => engagementValue }));

const CID = "11111111-1111-4111-8111-111111111111";
const PY = 2025;

const upload: WorkspaceUpload = {
  id: "upload-qa-1",
  file_name: "FAStdTrialBalance.xls",
  file_path: "x",
  file_size: 91136,
  company_id: CID,
  company_name: "CFOCLOSE-QA-20260915-01",
  status: "complete",
  uploaded_at: "2026-09-19T09:00:00.000Z",
  processed_at: "2026-09-18T12:19:00.000Z",
  is_valid: true, // process-trial-balance sets this true on classification completion — NOT proof of certification
  validation_report: { mapping_completeness: { mapped_accounts: 97, needs_review: 0, total_accounts: 97 } },
  accounting_errors: null,
  processing_result: { summary: { total_accounts: 97, auto_classified: 40 }, validation_report: { mapping_completeness: { mapped_accounts: 97, needs_review: 0 } } },
  period_year: PY,
  safisha_status: null,
};

const company: WorkspaceCompany = { id: CID, name: "CFOCLOSE-QA-20260915-01", code: null, tin: "123456789", reporting_framework: "full_ifrs", fiscal_year_end: "2025-12-31", currency: "TZS" };

/** Builds the exact live-observed contradiction: classification complete, TB arithmetic certification blocking. */
function contradictionSnapshot(): UploadSnapshot {
  return {
    id: upload.id,
    companyId: CID,
    companyName: company.name,
    periodYear: PY,
    status: "complete",
    isValid: true,
    safishaStatus: null,
    uploadedAt: upload.uploaded_at,
    processedAt: upload.processed_at,
    hasMapping: false,
    hesabuPassedAt: null,
    kingaSignedAt: null,
    filingSubmittedAt: null,
    certificationVerdict: "blocked",
    certificationBlocker: "Debits 185969447743.17 != Credits 185969172163.17 (difference: 275580.00)",
  };
}

/** A complete reconciliation as fetchWorkspaceSnapshot reads it: 8 lines, 7 matched and 1 exception approved. */
const EVALUATED = { state: "read" as const, evidence: { status: "clean", matched_count: 7, exception_count: 1, total_tb_lines: 8, exceptions: { pending: 0, approved: 1, rejected: 0, escalated: 0, approvedTbLines: 1 } } };

function mockWorkspace(snapshot: UploadSnapshot | null, reconciliation: WorkspaceUpload["reconciliation"] = null): UseWorkspaceDataReturn {
  const workspaceState = deriveWorkspaceState(CID, company.name, PY, snapshot);
  // In production the snapshot and the upload row come from the same trial_balance_uploads row; the reconciliation
  // record is read alongside it (fetchWorkspaceSnapshot).
  const row = { ...upload, safisha_status: snapshot?.safishaStatus ?? null, reconciliation };
  return {
    companyId: CID,
    periodYear: PY,
    company,
    upload: row,
    uploads: [row],
    workspaceState,
    loading: false,
    refreshing: false,
    refreshUpload: vi.fn(),
  };
}

async function renderOverview(snapshot: UploadSnapshot | null, reconciliation: WorkspaceUpload["reconciliation"] = null): Promise<string> {
  vi.resetModules();
  const value = mockWorkspace(snapshot, reconciliation);
  vi.doMock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => value }));
  const { default: WorkspaceOverview } = await import("./WorkspaceOverview");
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WorkspaceOverview)));
}

afterEach(() => {
  vi.doUnmock("@/contexts/WorkspaceContext");
  vi.restoreAllMocks();
});

describe("WorkspaceOverview — certification is the single authority for whether the trial balance is 'valid'", () => {
  it("the live-observed contradiction is fixed: an arithmetic-blocked certification never shows 'TB is valid' or any review-complete claim", async () => {
    const html = await renderOverview(contradictionSnapshot());

    expect(html).not.toContain("TB is valid");
    expect(html).not.toContain("No review required");
    expect(html).not.toMatch(/certified|approved|auditor-ready/i);
  });

  it("shows the exact required CTA and the real arithmetic difference, sourced from the single authority (workspaceState.nextAction)", async () => {
    const html = await renderOverview(contradictionSnapshot());

    expect(html).toContain("Resolve trial-balance difference");
    expect(html).toContain("275580.00");
  });

  it("a genuinely certified upload (verdict='certified') is a Reviewed trial balance (statements are withheld; not an approval)", async () => {
    const certified: UploadSnapshot = { ...contradictionSnapshot(), certificationVerdict: "certified", certificationBlocker: null };
    const html = await renderOverview(certified);

    expect(html).toContain("Reviewed trial balance.");
    expect(html).toContain("It is ready for statement preparation. This is not an approval of financial statements.");
    expect(html).not.toMatch(/TB is valid|Validate Draft Statements|reconciled|audited|assured|signed off/);
    expect(html.match(/data-testid="primary-cta"/g)?.length).toBe(1);
  });

  it("supporting-evidence reconciliation does not change the outcome: none, complete, incomplete, escalated, unreadable or not visible", async () => {
    const e = EVALUATED.evidence;
    const cases: [string | null, WorkspaceUpload["reconciliation"]][] = [
      [null, null],
      ["clean", EVALUATED],
      ["needs_review", { state: "read", evidence: { ...e, status: "needs_review", exceptions: { ...e.exceptions, pending: 1 } } }],
      ["needs_review", { state: "read", evidence: { ...e, exceptions: { ...e.exceptions, escalated: 1 } } }],
      ["needs_review", { state: "read", evidence: { ...e, matched_count: 0, total_tb_lines: 0 } }],
      ["blocked", { state: "read", evidence: { ...e, status: "blocked", exceptions: { ...e.exceptions, rejected: 1 } } }],
      ["clean", { state: "failed" }],
      ["clean", { state: "read", evidence: null }],
    ];
    for (const [safishaStatus, evidence] of cases) {
      const snap: UploadSnapshot = { ...contradictionSnapshot(), certificationVerdict: "certified", certificationBlocker: null, safishaStatus };
      const html = await renderOverview(snap, evidence);
      expect(html, String(safishaStatus)).toContain("Reviewed trial balance.");
      expect(html, String(safishaStatus)).not.toMatch(/reconciled|Reconcile supporting evidence|Resolve Reconciliation|not visible to you/i);
      expect(html.match(/data-testid="primary-cta"/g)?.length).toBe(1);
    }
  });

  it("a certification verdict that has not resolved yet (undefined) is treated identically to 'not certified' — never a silent pass", async () => {
    const { certificationVerdict, certificationBlocker, ...rest } = contradictionSnapshot();
    void certificationVerdict;
    void certificationBlocker;
    const html = await renderOverview({ ...rest });

    expect(html).not.toContain("TB is valid");
    expect(html).toContain("Certify the trial balance");
  });

  it("no upload at all still reaches the ordinary empty/launch state — PATH 6B does not fire without an upload", async () => {
    const html = await renderOverview(null);
    expect(html).not.toContain("TB is valid");
    expect(html).not.toContain("undefined");
  });
});

describe("WorkspaceOverview — orientation strip (requirement: visibly identify Entity, Period, Current stage, Current status, last completed milestone)", () => {
  it("shows entity, period, current stage and current status — sourced from the same workspaceState.nextAction the dominant CTA uses", async () => {
    const html = await renderOverview(contradictionSnapshot());

    expect(html).toContain(company.name);
    expect(html).toContain("FY" + PY);
    expect(html).toContain("Prepare Data:");
    expect(html).toContain("Resolve trial-balance difference");
  });

  it("file management (requirement: show file name, size, upload time and state): the active file's identity is visible, not just its name", async () => {
    const html = await renderOverview(contradictionSnapshot());

    expect(html).toContain(upload.file_name);
    expect(html).toContain("89 KB");
    expect(html).toContain("Complete");
  });

  it("a brand-new workspace with no completed stage shows no fabricated 'last completed' milestone", async () => {
    const html = await renderOverview(null);
    expect(html).not.toContain("last completed:");
  });

  it("a workspace with a genuinely completed stage shows its last completed milestone", async () => {
    const completed: UploadSnapshot = {
      ...contradictionSnapshot(),
      certificationVerdict: "certified",
      certificationBlocker: null,
      safishaStatus: "clean",
      hesabuPassedAt: "2026-02-01T00:00:00.000Z",
    };
    const html = await renderOverview(completed);
    expect(html).toContain("last completed:");
    expect(html).toContain("Prepare Data");
    expect(html).not.toContain("Prepare Statements");
  });
});
