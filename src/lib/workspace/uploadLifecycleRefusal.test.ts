/**
 * uploadLifecycleRefusal.test.ts — PR #32 F-01: only an ACTIVE upload is ever processed again.
 *   * the Edge Function rule (supabase/functions/_shared/uploadLifecycle.ts) and its 409, placed before any mutation
 *     in process-trial-balance;
 *   * the client gate (canReprocessUpload) that hides Retry and Save & reprocess for historical uploads.
 * The database refusal (trg_tbu_history_immutable, 20260923140000) is proven in scripts/db-proof/uploadLifecycle.mjs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), functions: { invoke: vi.fn() } } }));

import { ACTIVE_UPLOAD_LIFECYCLE_STATES, isActiveUploadLifecycle, processingRefusal } from "../../../supabase/functions/_shared/uploadLifecycle";
import { canReprocessUpload } from "./resolveActiveUpload";
import { UploadsStatusPanel } from "@/components/UploadsStatusPanel";

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
