/**
 * uploadLifecycleRefusal.test.ts — PR #32 F-01: only an ACTIVE upload is ever processed again.
 *   * the Edge Function rule (supabase/functions/_shared/uploadLifecycle.ts) and its 409, placed before any mutation
 *     in process-trial-balance;
 *   * the client gate (canReprocessUpload) that hides Retry and Save & reprocess for historical uploads.
 * Re-review of fa56822: N-02 source binding (409 before storage), N-01 comparative fail-closed, N-04 UI controls.
 * The database refusals (20260923140000, 20260923150000) are proven in scripts/db-proof/uploadLifecycle.mjs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), functions: { invoke: vi.fn() } } }));

import { ACTIVE_UPLOAD_LIFECYCLE_STATES, isActiveUploadLifecycle, processingRefusal, sourceBindingRefusal } from "../../../supabase/functions/_shared/uploadLifecycle";
import { canReprocessUpload } from "./resolveActiveUpload";
import { UploadsStatusPanel } from "@/components/UploadsStatusPanel";
import { buildClassificationDecision } from "@/components/workspace/decisionBuilders";
import { ValidationReport } from "@/components/ValidationReport";
import type { ClassificationPresentation } from "./classificationPresentation";

const ACTIVE = ["active_unprocessed", "active_processing", "active_processed", "blocked"] as const;
const HISTORICAL = ["superseded", "retired", "discarded", "discard_pending"] as const;
const UNKNOWN = [null, undefined, "", "ACTIVE_PROCESSED", "archived", 1] as const;

describe("process-trial-balance lifecycle refusal", () => {
  it("the active set is exactly the four active states", () => expect([...ACTIVE_UPLOAD_LIFECYCLE_STATES]).toEqual([...ACTIVE]));
  it.each(ACTIVE)("%s is processed normally", (s) => {
    expect(isActiveUploadLifecycle(s)).toBe(true);
    expect(processingRefusal(s)).toBeNull();
  });
  it.each(HISTORICAL)("%s is refused with a structured Conflict", (s) => {
    expect(processingRefusal(s)).toMatchObject({ status: "not_active", error: "Conflict", lifecycle_state: s });
  });
  it.each(UNKNOWN.map((u) => [u]))("missing/unknown %j fails closed", (s) => {
    expect(processingRefusal(s)).toMatchObject({ status: "not_active", error: "Conflict" });
  });

  const src = readFileSync(resolve(__dirname, "../../../supabase/functions/process-trial-balance/index.ts"), "utf8");
  it("returns 409 after authorization and BEFORE the first write to the upload row", () => {
    const refusal = src.indexOf("processingRefusal(");
    const status409 = src.indexOf("status: 409", refusal);
    const auth = src.indexOf("resolveProcessingActor(");
    const firstWrite = src.indexOf('.from("trial_balance_uploads").update(');
    const download = src.indexOf('.from("trial-balance-files").download(');
    expect(refusal).toBeGreaterThan(auth);
    expect(status409).toBeGreaterThan(refusal);
    expect(status409).toBeLessThan(firstWrite);
    expect(status409).toBeLessThan(download);
  });
});

describe("client reprocess gate", () => {
  it.each(ACTIVE)("%s may be reprocessed", (s) => expect(canReprocessUpload({ lifecycle_state: s })).toBe(true));
  it.each([...HISTORICAL, ...UNKNOWN].map((s) => [s]))("%j may not", (s) =>
    expect(canReprocessUpload({ lifecycle_state: s as string | null })).toBe(false));
  it("no upload → false", () => {
    expect(canReprocessUpload(null)).toBe(false);
    expect(canReprocessUpload(undefined)).toBe(false);
  });
  it("PrepareWorkspace gates the review (Save & reprocess) panel on it", () => {
    const prep = readFileSync(resolve(__dirname, "../../pages/workspace/PrepareWorkspace.tsx"), "utf8");
    expect(prep).toMatch(/const showReviewPanel =[\s\S]{0,200}canReprocessUpload\(upload\)/);
  });
});

describe("UploadsStatusPanel: Retry only on an active blocked upload", () => {
  const blocked = (id: string, lifecycle_state: string | null | undefined) => ({
    id, file_name: `${id}.csv`, uploaded_at: "2026-09-24T00:00:00Z", processed_at: null, status: "blocked",
    is_valid: false, company_name: "Co", processing_result: null, lifecycle_state,
  });
  const retryFor = (lifecycle_state: string | null | undefined) => {
    const html = renderToStaticMarkup(createElement(UploadsStatusPanel, {
      uploads: [blocked("u1", lifecycle_state)], selectedId: null, onSelect: () => {}, onRefresh: async () => {}, onDiscard: () => {},
    }));
    expect(html).toContain('data-upload-id="u1"');
    return html.includes('data-testid="upload-retry"');
  };
  it.each(ACTIVE)("%s → Retry shown", (s) => expect(retryFor(s)).toBe(true));
  it.each(HISTORICAL)("%s → no Retry", (s) => expect(retryFor(s)).toBe(false));
  it.each([[null], [undefined], ["bogus"]])("%j → no Retry (fails closed)", (s) => expect(retryFor(s)).toBe(false));
  it("the handler itself refuses a non-active upload before any write", () => {
    const panel = readFileSync(resolve(__dirname, "../../components/UploadsStatusPanel.tsx"), "utf8");
    const guard = panel.indexOf("!canReprocessUpload(u)) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(panel.indexOf('.from("trial_balance_uploads")'));
  });
});

// ── Re-review of fa56822 ─────────────────────────────────────────────────────────────────────

describe("N-02: process-trial-balance refuses an unbound source before touching storage", () => {
  it("only an explicit true passes; anything else is a structured Conflict that names no object", () => {
    expect(sourceBindingRefusal(true)).toBeNull();
    for (const v of [false, null, undefined, "true", 1, {}]) {
      const r = sourceBindingRefusal(v);
      expect(r).toMatchObject({ status: "source_not_bound", error: "Conflict" });
      expect(JSON.stringify(r)).not.toMatch(/exist|workspaces\//i);
    }
  });
  const src = readFileSync(resolve(__dirname, "../../../supabase/functions/process-trial-balance/index.ts"), "utf8");
  it("the binding check runs after the lifecycle refusal and BEFORE the first write and the storage download", () => {
    const life = src.indexOf("processingRefusal(");
    const bind = src.indexOf('rpc("tbu_upload_source_bound"');
    const refusal = src.indexOf("sourceBindingRefusal(", bind);
    expect(bind).toBeGreaterThan(life);
    expect(refusal).toBeGreaterThan(bind);
    expect(refusal).toBeLessThan(src.indexOf('.from("trial_balance_uploads").update('));
    expect(refusal).toBeLessThan(src.indexOf('.from("trial-balance-files").download('));
    expect(src.slice(bind, refusal + 80)).toMatch(/bindErr \? null : sourceBound/); // an RPC error fails closed
  });
});

describe("N-01: the comparative engine fails closed on a stale period pointer", () => {
  const src = readFileSync(resolve(__dirname, "../../../supabase/functions/_shared/comparativeAssurance.ts"), "utf8");
  it("reads lifecycle_state and company_id for both periods and refuses a non-active or foreign upload before comparing", () => {
    expect(src.match(/select\("processing_result, company_name, company_id, lifecycle_state"\)/g)?.length).toBe(2);
    const guard = src.indexOf("isActiveUploadLifecycle(u.lifecycle_state)");
    expect(guard).toBeGreaterThan(-1);
    expect(src.slice(guard, guard + 120)).toMatch(/u\.company_id !== company_id/);
    expect(guard).toBeLessThan(src.indexOf("extractTotals(curPR)"));
    expect(src.slice(guard, guard + 600)).toMatch(/status: 409/);
  });
});

describe("N-04: no actionable reprocessing control for a non-active upload", () => {
  const failed = { state: "FAILED", headline: "Processing failed", detail: "d" } as unknown as ClassificationPresentation;
  const base = { retrying: false, prepareHref: "/p", reviewHref: "/r" };
  it("WorkspaceOverview's decision: Retry only when onRetry is supplied; otherwise a plain link to Prepare", () => {
    const withRetry = buildClassificationDecision(failed, { ...base, onRetry: () => undefined });
    const without = buildClassificationDecision(failed, base);
    expect(withRetry.button?.label).toBe("Retry processing");
    expect(without.button?.label).toBe("Open Prepare Data");
    expect((without.button as { onClick?: unknown }).onClick).toBeUndefined();
    expect((without.button as { href?: string }).href).toBe("/p");
  });
  it("WorkspaceOverview supplies onRetry only for an active upload, and the handler re-checks", () => {
    const ov = readFileSync(resolve(__dirname, "../../pages/workspace/WorkspaceOverview.tsx"), "utf8");
    expect(ov).toMatch(/onRetry: canReprocessUpload\(upload\) \? handleRetryProcessing : undefined/);
    const h = ov.indexOf("const handleRetryProcessing");
    expect(ov.slice(h, h + 300)).toMatch(/!canReprocessUpload\(upload\)\) return;/);
    expect(ov.indexOf("!canReprocessUpload(upload)) return;")).toBeLessThan(ov.indexOf('.from("trial_balance_uploads")'));
  });
  const audited = (onProcessAsAuditedAccounts?: () => void) => renderToStaticMarkup(createElement(ValidationReport, {
    report: { tb_balance_check: { passed: false, total_debits: 1, total_credits: 1, difference: 900_000_000 }, mapping_completeness: { passed: true } },
    errors: [{ code: "TRIAL_BALANCE_IMBALANCE", message: "imbalance" }], isValid: false, status: "blocked", fileName: "fs.xlsx",
    onProcessAsAuditedAccounts, onUploadNew: () => undefined,
  } as unknown as Parameters<typeof ValidationReport>[0]));
  it("'Process as Audited Financial Statements' renders only when the action is supplied", () => {
    expect(audited(() => undefined)).toContain("Process as Audited Financial Statements");
    const hidden = audited(undefined);
    expect(hidden).not.toContain("Process as Audited Financial Statements");
    expect(hidden).toContain("Upload correct Trial Balance");
  });
  it("PrepareWorkspace supplies it only for an active upload, and the handler re-checks before invoking the engine", () => {
    const prep = readFileSync(resolve(__dirname, "../../pages/workspace/PrepareWorkspace.tsx"), "utf8");
    expect(prep).toMatch(/onProcessAsAuditedAccounts=\{canReprocessUpload\(upload\) \? handleProcessAsAuditedAccounts : undefined\}/);
    const h = prep.indexOf("const handleProcessAsAuditedAccounts");
    const guard = prep.indexOf("!canReprocessUpload(upload)) return;", h);
    expect(guard).toBeGreaterThan(h);
    expect(guard).toBeLessThan(prep.indexOf('invoke("process-trial-balance"', h));
  });
});
