/**
 * ManageTrialBalance, rendered (server-side markup; this project has no DOM test harness), and its placement on
 * Prepare Data and the Overview link that lands on it.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { RemoveAction, SourceManagementMode } from "@/lib/workspace/trialBalanceManagement";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } } }));
const { ManageTrialBalance, REMOVE_CONFIRMATION_COPY } = await import("./ManageTrialBalance");

const render = (mode: SourceManagementMode, removeAction: RemoveAction | null, focusRequested = false) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ManageTrialBalance, {
    mode, removeAction, replacing: false, removing: false, focusRequested, onReplace: () => {}, onRemove: () => {},
  })));
const src = (p: string) => fs.readFileSync(path.join(__dirname, "../../..", p), "utf8");

describe("Manage Trial Balance — what each person sees", () => {
  it("active plan + source authority + a Blocked upload: Replace and Remove, both enabled", () => {
    const html = render("manage", { kind: "remove" });
    expect(html).toContain("Manage Trial Balance");
    expect(html).toContain('data-testid="replace-trial-balance"');
    expect(html).toMatch(/data-testid="remove-trial-balance"[^>]*>/);
    expect(html).not.toMatch(/data-testid="remove-trial-balance"[^>]*disabled/);
    expect(html).toContain("Replace Trial Balance");
    expect(html).toContain("Remove Trial Balance");
  });
  it("issued output: Remove is disabled with the precise preservation reason; Replace stays available", () => {
    const html = render("manage", { kind: "unavailable", reason: "A Reporting Pack has been issued for this period, so this Trial Balance stays in use and preserved." });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="remove-trial-balance"|data-testid="remove-trial-balance"[^>]*disabled/);
    expect(html).toContain("stays in use and preserved");
    expect(html).toContain('data-testid="replace-trial-balance"');
  });
  it("view-only: no mutation control at all, with a clear explanation", () => {
    const html = render("view_only", null);
    expect(html).not.toContain("replace-trial-balance");
    expect(html).not.toContain("remove-trial-balance");
    expect(html).toContain("needs source-file access");
  });
  it("archive-only (no current plan): no mutation control; historical read-only with View plans", () => {
    const html = render("archive", { kind: "remove" });
    expect(html).not.toContain("replace-trial-balance");
    expect(html).not.toContain("remove-trial-balance");
    expect(html).toContain("read-only because its account has no current plan");
    expect(html).toContain('href="/plans"');
    expect(html).toContain("View plans");
  });
  it("unknown access: no mutation control", () => {
    const html = render("unknown", { kind: "remove" });
    expect(html).not.toContain("replace-trial-balance");
    expect(html).not.toContain("remove-trial-balance");
  });
  it("the confirmation copy is exactly the required wording; confirming is explicit (a dialog, not a direct call)", () => {
    expect(REMOVE_CONFIRMATION_COPY).toBe("Remove this Trial Balance from active use? Existing audit history and evidence records will remain preserved.");
    const comp = src("src/components/workspace/ManageTrialBalance.tsx");
    expect(comp).toMatch(/onClick=\{\(\) => setConfirmOpen\(true\)\}/);
    expect(comp).toMatch(/await onRemove\(\);/);
    expect(comp.indexOf("setConfirmOpen(true)")).toBeLessThan(comp.indexOf("await onRemove();"));
  });
  it("carries the anchor the Overview link targets, and marks itself focused when asked", () => {
    expect(render("manage", { kind: "remove" }, true)).toMatch(/id="manage-trial-balance"[^>]*data-mode="manage"|id="manage-trial-balance"/);
    expect(render("manage", { kind: "remove" }, true)).toContain("ring-2");
  });
});

describe("placement and wiring on Prepare Data", () => {
  const prep = src("src/pages/workspace/PrepareWorkspace.tsx");
  it("the management area sits in the Current Trial Balance card, before the checks (visible without scrolling past them)", () => {
    const card = prep.indexOf("<CurrentTrialBalanceCard");
    const manage = prep.indexOf("<ManageTrialBalance");
    expect(card).toBeGreaterThan(0);
    expect(manage).toBeGreaterThan(card);
    expect(manage).toBeLessThan(prep.indexOf("<TrialBalanceChecks"));
    expect(prep).toMatch(/variant="inline"/);
    // Replace is never offered twice: hidden from the secondary actions when it is already the primary action.
    expect(prep).toMatch(/hideReplace=\{verdict\.primaryAction\?\.kind === "replace" && sourceMode === "manage"\}/);
  });
  it("Remove is never hidden by processing status: no isCertifiedRun gate; the server's eligibility decides", () => {
    expect(prep).not.toMatch(/isCertifiedRun\(upload\)/);
    expect(prep).toMatch(/decideRemoveAction\(upload, currentEligibility\)/);
    expect(prep).toMatch(/fetchRemovalEligibility\(upload\.id\)/);
  });
  it("Remove uses the lifecycle (retire / discard saga / cancel replacement) — never a table delete", () => {
    const handler = prep.slice(prep.indexOf("const handleRemove"), prep.indexOf("const certReadiness"));
    expect(handler).toMatch(/removeTrialBalance\(target\)/);
    expect(handler).toMatch(/discardUpload\(target\)/);
    expect(handler).toMatch(/cancelReplacement\(target\)/);
    expect(prep).not.toMatch(/\.delete\(\)/);
    // The page only READS trial_balance_uploads (a status poll); it never writes or deletes it.
    expect(prep).not.toMatch(/from\("trial_balance_uploads"\)\s*\.(delete|update|insert|upsert)\(/);
  });
  it("after removal the page leaves the removed file and shows Upload Trial Balance; Undo is offered only for the discard saga", () => {
    const empty = prep.slice(prep.indexOf("const showEmptySourceState"), prep.indexOf("const handleRemove"));
    expect(empty).toMatch(/suppressUpload\(prev, removedId\)/);
    expect(empty).toMatch(/setShowUploader\(true\)/);
    expect(prep).toContain('label="Upload Trial Balance"');
    const handler = prep.slice(prep.indexOf("const handleRemove"), prep.indexOf("const certReadiness"));
    expect(handler.match(/offerUndo\(/g)?.length).toBe(1);
    const removeBranch = handler.slice(handler.indexOf('removeAction.kind === "remove"'), handler.indexOf('removeAction.kind === "discard"'));
    expect(removeBranch).not.toMatch(/offerUndo/);
  });
  it("Replace validates the file first and swaps atomically (retire), so a failure leaves the current Trial Balance active", () => {
    const replace = prep.slice(prep.indexOf("const handleReplacePicked"), prep.indexOf("const showEmptySourceState"));
    expect(replace.indexOf("validateReplacementFile(file)")).toBeLessThan(replace.indexOf("retireAndProcess(upload, file)"));
    expect(replace).not.toMatch(/discardUpload/);
    expect(replace).toMatch(/current Trial Balance is still active/);
  });
});

describe("the Overview's Manage file link opens the management area", () => {
  it("the Overview has ONE Manage link (the file line's Manage file →), using the focusing route; the decision card has no duplicate", () => {
    const overview = src("src/pages/workspace/WorkspaceOverview.tsx");
    expect(overview).toMatch(/const manageUploadHref = buildManageTrialBalanceRoute\(companyId, periodYear, upload\?\.id \?\? null\);/);
    expect(overview).toMatch(/manageHref=\{manageUploadHref\}/);
    expect(overview).toMatch(/<DecisionCard decision=\{decision\} \/>/);
    const card = src("src/components/workspace/DecisionCard.tsx");
    expect(card).not.toContain("replace-file-escape");
    expect(card).not.toContain("Manage Trial Balance: replace or remove it");
  });
});

describe("the server contract (static; behaviour is proven on real PostgreSQL, planCapabilities.mjs R-1)", () => {
  const sql = src("supabase/migrations/20260927100000_trial_balance_remove_from_active_use.sql");
  it("retires, never deletes; authorizes with the PR #32 source authority; refuses issued output; audits", () => {
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.trial_balance_uploads/i);
    expect(sql).toMatch(/SET lifecycle_state = 'retired'/);
    expect(sql).toMatch(/public\.tbu_authorize\(v_row\.company_id\)/);
    expect(sql).toMatch(/'issued_output_bound'/);
    expect(sql).toMatch(/public\.tbu_log_event\([\s\S]*'retired'/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.remove_trial_balance_upload\(UUID, BIGINT, TEXT\) TO authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.tbu_issued_output_binding\(UUID, INTEGER\) FROM PUBLIC, anon, authenticated, service_role/);
  });
  it("serializes removal, FINAL publication and Reporting Pack sealing with ONE advisory lock per workspace and period (proven: planCapabilities.mjs R-2)", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('cfoclose\.tb_official_output:'/);
    // Removal takes the lock before it locks the row and before it checks issued output.
    const remove = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.remove_trial_balance_upload"), sql.indexOf("CREATE OR REPLACE FUNCTION public.fsp_source_trial_balance_guard"));
    expect(remove.indexOf("tb_official_output_lock(")).toBeGreaterThan(0);
    expect(remove.indexOf("tb_official_output_lock(")).toBeLessThan(remove.indexOf("FOR UPDATE"));
    expect(remove.indexOf("tb_official_output_lock(")).toBeLessThan(remove.indexOf("tbu_issued_output_binding("));
    // FINAL publication and sealing take the identical lock in BEFORE triggers (every write path).
    expect(sql).toMatch(/CREATE TRIGGER trg_fsp_source_trial_balance_guard\s+BEFORE INSERT ON public\.financial_statement_publications\s+FOR EACH ROW WHEN \(NEW\.state = 'FINAL'\)/);
    expect(sql).toMatch(/CREATE TRIGGER trg_rpi_seal_source_guard\s+BEFORE UPDATE OF consumed_at ON public\.reporting_pack_issuances/);
    for (const fn of ["fsp_source_trial_balance_guard", "rpi_seal_source_guard"]) {
      const body = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}()`));
      expect(body.indexOf("tb_official_output_lock(")).toBeLessThan(body.indexOf("tb_period_source_removed("));
    }
    expect(sql).toMatch(/SOURCE_TRIAL_BALANCE_REMOVED[\s\S]*ERRCODE = 'PT409'/);
  });
  it("refuses any isolation level but READ COMMITTED, centrally, before any write or audit (PT412; proven: planCapabilities.mjs R-3)", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.tb_require_read_committed\(\)[\s\S]*?current_setting\('transaction_isolation'\) IS DISTINCT FROM 'read committed'[\s\S]*?RAISE EXCEPTION 'READ_COMMITTED_REQUIRED' USING ERRCODE = 'PT412'/);
    const lock = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.tb_official_output_lock"));
    expect(lock.indexOf("tb_require_read_committed()")).toBeLessThan(lock.indexOf("pg_advisory_xact_lock("));
    const remove = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.remove_trial_balance_upload"));
    expect(remove.indexOf("PERFORM public.tb_require_read_committed();")).toBeLessThan(remove.indexOf("SELECT * INTO v_row"));
  });
});
