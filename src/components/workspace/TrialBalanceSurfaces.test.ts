/**
 * The Prepare Data trial-balance surfaces, rendered (server-side markup; this project has no DOM harness), and the
 * page / Overview / account-home wiring that makes them the single statement of the result.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { PreflightCheck } from "@/lib/workspace/computePreflight";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } } }));
const { CurrentTrialBalanceCard } = await import("./CurrentTrialBalanceCard");
const { TrialBalanceChecks } = await import("./TrialBalanceChecks");
const { UploadHistory } = await import("./UploadHistory");
const { deriveTrialBalanceVerdict } = await import("@/lib/workspace/trialBalanceVerdict");
const { default: EngagementHub } = await import("@/pages/workspace/EngagementHub");

const src = (p: string) => fs.readFileSync(path.join(__dirname, "../../..", p), "utf8");
const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, node));
const layers = (l3: PreflightCheck["state"]): PreflightCheck[] => [
  { id: "l1_structure", label: "", state: "passed", detail: "" },
  { id: "l2_data_quality", label: "", state: "passed", detail: "" },
  { id: "l3_arithmetic", label: "", state: l3, detail: "Debits 10 != Credits 8 (difference: 2)" },
  { id: "l4_classification", label: "", state: "passed", detail: "" },
  { id: "l5_supporting_evidence", label: "", state: "pending", detail: "NOT_EVALUATED: x" },
];
const pr = { validation_report: { tb_balance_check: { total_debits: 10, total_credits: 8, difference: 2 } } };
const blocked = deriveTrialBalanceVerdict({ upload: { status: "blocked", processing_result: pr }, readiness: { verdict: "blocked", blocker: "x", checks: layers("failed") }, canRetry: true });
const accepted = deriveTrialBalanceVerdict({ upload: { status: "complete", processing_result: { validation_report: { tb_balance_check: { total_debits: 10, total_credits: 10, difference: 0 } } } }, readiness: { verdict: "certified", blocker: null, checks: layers("passed") }, canRetry: true });
const card = (verdict: typeof blocked) => render(createElement(CurrentTrialBalanceCard, { fileName: "TB.xlsx", uploadedAt: "2026-09-30T10:40:00Z", fileSize: 21_000, verdict, onPrimary: () => {} }));

describe("Current Trial Balance card", () => {
  it("blocked: file, status, totals, plain reason, and ONE action — replace with a corrected file", () => {
    const html = card(blocked);
    expect(html).toContain("TB.xlsx");
    expect(html).toContain("Blocked");
    for (const t of ["Total debits", "10.00", "Total credits", "8.00", "Difference", "2.00"]) expect(html).toContain(t);
    expect(html).toContain("Debits exceed credits by 2.00. Correct the file and replace it.");
    expect(html).toContain("Replace with corrected Trial Balance");
    expect(html).not.toContain("Retry processing");
    expect(html.match(/data-testid="trial-balance-primary-action"/g)?.length).toBe(1);
  });
  it("the status is a control that goes straight to the checks that decided it", () => {
    expect(card(blocked)).toMatch(/<button[^>]*aria-controls="trial-balance-checks"[^>]*data-testid="trial-balance-status"/);
  });
  it("accepted: evidence verification is the next step", () => {
    const html = card(accepted);
    expect(html).toContain("Accepted");
    expect(html).toContain("Verify against bank and mobile-money evidence");
  });
  it("the difference reads 'Balanced' at exact zero and 'Accepted — within the TZS 1.00 tolerance' for 1–100 cents; never on a block", () => {
    expect(card(accepted)).toMatch(/data-testid="trial-balance-balance-statement">Balanced</);
    const within = deriveTrialBalanceVerdict({ upload: { status: "complete", processing_result: { validation_report: { tb_balance_check: { total_debits: 10.6, total_credits: 10, difference: 0 } } } }, readiness: { verdict: "certified", blocker: null, checks: layers("passed") }, canRetry: true });
    const html = card(within);
    expect(html).toContain("0.60");
    expect(html).toMatch(/data-testid="trial-balance-balance-statement">Accepted — within the TZS 1.00 tolerance</);
    expect(card(blocked)).not.toContain("trial-balance-balance-statement");
  });
});

describe("Trial balance checks", () => {
  it("one list, same verdict as the card; informational items apart and labelled as not deciding acceptance", () => {
    const html = render(createElement(TrialBalanceChecks, { verdict: blocked }));
    expect(html).toContain('id="trial-balance-checks"');
    expect(html).toContain("3 of 4 passed");
    expect(html).toMatch(/data-testid="check-l3_arithmetic" data-state="failed"/);
    expect(html).toContain("For information — does not decide acceptance");
    expect(html).not.toMatch(/NOT_EVALUATED|!=/);
  });
});

describe("Upload history", () => {
  it("collapsed by default, read-only: no delete, no retry", () => {
    const html = render(createElement(UploadHistory, { uploads: [{ id: "a", file_name: "TB.xlsx", uploaded_at: "2026-09-27T10:00:00Z", status: "blocked", lifecycle_state: "superseded" }], currentId: "b", viewingId: "b", onOpen: () => {} }));
    expect(html).toContain("Upload history");
    expect(html).toContain("aria-expanded=\"false\"");
    const component = src("src/components/workspace/UploadHistory.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(component).not.toMatch(/Trash|Retry|discard|onDiscard/i);
  });
});

describe("Prepare Data wiring", () => {
  const prep = src("src/pages/workspace/PrepareWorkspace.tsx");
  it("the result is stated once: card → checks → (evidence) → technical details → history; the old duplicates are gone", () => {
    const jsx = prep.slice(prep.lastIndexOf("  return ("));
    const order = ["<CurrentTrialBalanceCard", "<TrialBalanceChecks", 'id="evidence-verification"', "Technical processing details", "<UploadHistory"].map((m) => jsx.indexOf(m));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const gone of ["TrialBalancePreflight", "UploadsStatusPanel", "<DiscardUploadDialog", "CertificationHeader", "CertificationSummaryStrip", "TrialBalanceIntegrityCard", "Evidence and processing details", "Previous trial balances"]) expect(prep, gone).not.toContain(gone);
  });
  it("evidence verification appears only for an accepted trial balance, is never opened by processing alone, and stays mandatory", () => {
    expect(prep).toMatch(/\{verdict\.evidenceUnlocked && !verdict\.evidenceCleared && canReprocessUpload\(upload\) && \(/);
    expect(prep).not.toMatch(/setSafishaUpload|safishaUpload/);
    expect(prep).toMatch(/evidenceGateHandledByParent/);
  });
  it("one verdict feeds the card, the checks and the technical ledger", () => {
    expect(prep).toContain("const verdict = deriveTrialBalanceVerdict({ upload: upload ?? null, readiness, readinessSubject: certReadiness.subjectKey, canRetry: canReprocessUpload(upload) });");
    // The read is keyed on the upload's subject (id, version, source hash), so a new version is a fresh read.
    expect(prep).toContain("useCertificationReadiness(companyId, periodYear, upload?.id, uploadSubjectKey(upload))");
    expect(prep).toMatch(/<TrialBalanceProgressLedger upload=\{upload\} failedCheckId=\{verdict\.failedCheckId\} \/>/);
  });
  it("retry only re-runs the Edge Function; the page makes no financial write", () => {
    const retry = prep.slice(prep.indexOf("const handleRetry"), prep.indexOf("const scrollTo"));
    expect(retry).toMatch(/functions\.invoke\("process-trial-balance"/);
    expect(retry).not.toMatch(/\.from\(|\.update\(|\.insert\(/);
  });
});

describe("Overview", () => {
  it("a blocked trial balance gets its own decision (replace, focused on the management area), before the processing-failure branch", () => {
    const o = src("src/pages/workspace/WorkspaceOverview.tsx");
    expect(o).toMatch(/const isFailed = classification\.state === "FAILED" && !isBlockedTrialBalance;/);
    expect(o.indexOf("} else if (isBlockedTrialBalance) {")).toBeLessThan(o.indexOf("} else if (isFailed) {"));
    expect(o).toMatch(/headline: "The trial balance is blocked\."/);
  });
});

describe("Account home (the CFOClose logo from inside a workspace)", () => {
  const account = (capacity: { capacity: number | null; used: number | null; determined: boolean }) => ({
    billing: null, billingLoading: false, billingError: true,
    capacity: { ...capacity, planCode: "PRACTICE" }, capacityLoading: false, capacityError: false,
    onRetry: () => {}, onSignOut: () => {},
  });
  const hub = (acc: ReturnType<typeof account> | undefined) =>
    render(createElement(EngagementHub, { entries: [], companiesWithoutEngagement: [], onResume: () => {}, onStartService: () => {}, account: acc }));
  it("existing navigation only: Plans, Settings, Sign out, the existing company flow in Settings and the current plan", () => {
    const html = hub(account({ capacity: 5, used: 2, determined: true }));
    for (const href of ['href="/plans"', 'href="/settings"']) expect(html).toContain(href);
    expect(html).toContain("Sign out");
    expect(html).toContain('data-testid="manage-companies"');
    expect(html).toContain('data-testid="account-plan"');
    expect(html).toContain("No open engagements");
  });
  it("capacity is stated by the existing notice (it hides itself when there is room); no client-side creation logic", () => {
    expect(hub(account({ capacity: 5, used: 2, determined: true }))).not.toContain("Entity capacity reached");
    expect(hub(account({ capacity: 1, used: 1, determined: true }))).toContain("Entity capacity reached");
    const src2 = src("src/pages/workspace/EngagementHub.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src2).not.toMatch(/FirstRunEngagement|create_entity|canAddCompany|capacity\.used\s*</);
    expect(src("src/lib/commercial/paidActions.ts")).not.toContain("canAddCompany");
  });
  it("the plain chooser (no account) is unchanged", () => {
    const html = hub(undefined);
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain('data-testid="manage-companies"');
  });
  it("the workspace logo leads here (forced hub), and Dashboard supplies the account home", () => {
    expect(src("src/pages/workspace/WorkspaceLayout.tsx")).toMatch(/to="\/dashboard"[\s\S]{0,400}state=\{\{ forceHub: true \}\}/);
    expect(src("src/pages/Dashboard.tsx")).toMatch(/account=\{\{[\s\S]*onSignOut:/);
  });
});
