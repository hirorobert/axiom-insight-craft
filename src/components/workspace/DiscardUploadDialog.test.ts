/**
 * DiscardUploadDialog.test.ts — lifecycle-safe discard / replace / cancel / Undo (client contract).
 *
 * Root cause this proves fixed: 20260922180000's discard_trial_balance_upload() deleted
 * trial_balance_uploads directly, cascading into the append-only tb_certifications table. That table
 * unconditionally refuses ANY delete, including one arriving via cascade, so any upload with
 * processing/certification history could never be discarded (confirmed live during authenticated UI
 * acceptance of PR #32 against axiom-omega3-staging-replay). 20260923100000 replaces this with a formal
 * lifecycle and USER-BASED authority:
 *   - discard_trial_balance_upload() is a two-phase saga, restricted to genuinely unprocessed uploads.
 *     The trial-balance-storage-cleanup Edge Function performs the authorized file removal and completion,
 *     and the database accepts no client "removed" claim.
 *   - retire_trial_balance_upload() is the only path for anything with history, and deletes nothing.
 *   - cancel_trial_balance_replacement() removes an unprocessed replacement and restores its predecessor.
 *   - restore_trial_balance_upload() answers Undo with an explicit outcome, checking Storage itself.
 * The behaviour against a real database is proven by scripts/db-proof/uploadLifecycle.mjs, and end to end on
 * hosted staging by scripts/upload_lifecycle_staging.mjs. These tests pin the client contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const supa = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  insert: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string, args: unknown) => supa.rpc(name, args),
    functions: { invoke: (name: string, opts: unknown) => supa.invoke(name, opts) },
    auth: { getUser: () => supa.getUser() },
    from: (table: string) => ({ insert: (row: unknown) => supa.insert(table, row) }),
    storage: {
      from: () => ({
        download: (p: string) => supa.download(p),
        remove: (p: string[]) => supa.remove(p),
        upload: (p: string, f: unknown, o: unknown) => supa.upload(p, f, o),
      }),
    },
  },
}));

afterEach(() => vi.clearAllMocks());

const TARGET = { id: "u1", file_name: "tb.xlsx", file_path: "owner-1/tb.xlsx", status: "processing", is_valid: null, version: 1 };
const ROW_SNAPSHOT = { id: "u1", file_name: "tb.xlsx", status: "processing" };

function beginRow(outcome: string, extra: Partial<{ operation_id: string; row_snapshot: unknown; file_path: string | null; detail: string | null }> = {}) {
  return { data: [{ outcome, operation_id: null, row_snapshot: null, file_path: null, detail: null, ...extra }], error: null };
}
function retireRow(outcome: string, extra: Partial<{ new_upload_id: string; retired_upload_id: string; detail: string | null }> = {}) {
  return { data: [{ outcome, new_upload_id: null, retired_upload_id: null, detail: null, ...extra }], error: null };
}
/** The Edge Function's answer: 2xx carries data; non-2xx surfaces as a FunctionsHttpError whose context is the Response. */
const cleanupOk = (outcome: string) => ({ data: { outcome }, error: null });
const cleanupHttpError = (outcome: string) => ({ data: null, error: { message: "Edge Function returned a non-2xx status code", context: { json: async () => ({ outcome }) } } });

describe("discardUpload — two-phase saga; the file is removed by the server-authoritative Edge Function", () => {
  it("happy path: begin -> Edge Function (operation id ONLY) -> completed; receipt carries the operation id and snapshot", async () => {
    const blob = new Blob(["contents"]);
    supa.download.mockResolvedValueOnce({ data: blob });
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "owner-1/tb.xlsx" }));
    supa.invoke.mockResolvedValueOnce(cleanupOk("completed"));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", operationId: "op1", row: ROW_SNAPSHOT, filePath: "owner-1/tb.xlsx", fileBlob: blob });
    expect(supa.rpc).toHaveBeenCalledWith("discard_trial_balance_upload", { p_upload_id: "u1", p_expected_version: 1 });
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-storage-cleanup", { body: { operation_id: "op1" } });
    // The browser neither deletes the file nor claims its deletion to the database.
    expect(supa.remove).not.toHaveBeenCalled();
    expect(supa.rpc).toHaveBeenCalledTimes(1);
  });

  it("works for a file ANOTHER authorized user uploaded: the undo copy may be unavailable, the discard still completes", async () => {
    supa.download.mockResolvedValueOnce({ data: null, error: { message: "not allowed" } });
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "collaborator-9/tb.xlsx" }));
    supa.invoke.mockResolvedValueOnce(cleanupOk("completed"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    const receipt = await discardUpload({ ...TARGET, file_path: "collaborator-9/tb.xlsx" });
    expect(receipt.fileBlob).toBeNull();
    expect(receipt.operationId).toBe("op1");
  });

  it("Storage cleanup not confirmed (non-2xx storage_cleanup_pending): the discard stays pending, retryable, never success", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "owner-1/tb.xlsx" }));
    supa.invoke.mockResolvedValueOnce(cleanupHttpError("storage_cleanup_pending"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ retryable: true });
  });

  it("an unreadable Edge Function answer is never treated as success", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "owner-1/tb.xlsx" }));
    supa.invoke.mockResolvedValueOnce({ data: null, error: { message: "network" } });
    const { discardUpload } = await import("./DiscardUploadDialog");
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ retryable: true });
  });

  it("Edge Function forbidden / replacement_required are surfaced with their codes", async () => {
    const { discardUpload } = await import("./DiscardUploadDialog");
    supa.download.mockResolvedValue({ data: null });
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "owner-1/tb.xlsx" }));
    supa.invoke.mockResolvedValueOnce(cleanupHttpError("forbidden"));
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "forbidden", retryable: false });
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "owner-1/tb.xlsx" }));
    supa.invoke.mockResolvedValueOnce(cleanupHttpError("replacement_required"));
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "replacement_required", retryable: false });
  });

  it("resume: a retried begin for an upload already discard_pending reuses the SAME operation", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op-existing", row_snapshot: ROW_SNAPSHOT, file_path: "owner-1/tb.xlsx", detail: "Resuming a previously started discard." }));
    supa.invoke.mockResolvedValueOnce(cleanupOk("already_completed"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    await discardUpload(TARGET);
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-storage-cleanup", { body: { operation_id: "op-existing" } });
  });

  it("already_discarded (begin): idempotent success, no Edge Function call, no undo operation", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("already_discarded"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", operationId: null, row: null, filePath: "owner-1/tb.xlsx", fileBlob: null });
    expect(supa.invoke).not.toHaveBeenCalled();
  });

  it("replacement_required — THE ROOT-CAUSE CASE: history refuses a hard delete with a named, non-retryable outcome", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("replacement_required"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "replacement_required", retryable: false });
    expect(supa.invoke).not.toHaveBeenCalled();
  });

  it("the server decides eligibility: a target the client believed unprocessed still gets replacement_required", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("replacement_required"));
    const { discardUpload, isCertifiedRun } = await import("./DiscardUploadDialog");
    const stale = { ...TARGET, lifecycle_state: "active_unprocessed" };
    expect(isCertifiedRun(stale)).toBe(false);
    await expect(discardUpload(stale)).rejects.toMatchObject({ code: "replacement_required" });
  });

  it("replacement_cancel_required, stale_version, forbidden, dependency_conflict stay distinct", async () => {
    const { discardUpload } = await import("./DiscardUploadDialog");
    supa.rpc.mockResolvedValueOnce(beginRow("replacement_cancel_required"));
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "replacement_cancel_required", retryable: false });
    supa.rpc.mockResolvedValueOnce(beginRow("stale_version"));
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "stale_version", retryable: true });
    supa.rpc.mockResolvedValueOnce(beginRow("forbidden"));
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "forbidden", retryable: false });
    supa.rpc.mockResolvedValueOnce(beginRow("dependency_conflict"));
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "dependency_conflict" });
  });

  it("user-facing copy never names a firm, partner, manager or other job title", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("forbidden"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    await expect(discardUpload(TARGET)).rejects.toThrow(/permission to manage this workspace's source files/);
    const src = readFileSync(join(__dirname, "DiscardUploadDialog.tsx"), "utf8");
    expect(src).not.toMatch(/owner or partner|partner of this company|firm member/i);
  });
});

describe("retireUpload — the only path for processed/certified/dependent uploads; never deletes anything", () => {
  const FILE = new File(["contents"], "replacement.csv", { type: "text/csv" });

  it("happy path: uploads the replacement file, calls retire_trial_balance_upload, returns the new upload id", async () => {
    supa.getUser.mockResolvedValueOnce({ data: { user: { id: "owner-1" } } });
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.rpc.mockResolvedValueOnce(retireRow("replaced", { new_upload_id: "u2", retired_upload_id: "u1" }));
    const { retireUpload } = await import("./DiscardUploadDialog");

    const result = await retireUpload(TARGET, FILE, "test reason");
    expect(result).toEqual({ newUploadId: "u2" });
    expect(supa.upload).toHaveBeenCalledTimes(1);
    expect(supa.rpc).toHaveBeenCalledWith("retire_trial_balance_upload", expect.objectContaining({
      p_old_upload_id: "u1", p_expected_version: 1, p_new_file_name: "replacement.csv", p_new_file_size: FILE.size, p_reason: "test reason",
    }));
  });

  it("forbidden: the orphaned uploaded file is cleaned up, error carries the forbidden code", async () => {
    supa.getUser.mockResolvedValueOnce({ data: { user: { id: "owner-1" } } });
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.remove.mockResolvedValueOnce({ data: [{ name: "removed" }], error: null });
    supa.rpc.mockResolvedValueOnce(retireRow("forbidden"));
    const { retireUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try { await retireUpload(TARGET, FILE); } catch (e) { caught = e; }
    expect((caught as InstanceType<typeof DiscardError>).code).toBe("forbidden");
    expect(supa.remove).toHaveBeenCalledTimes(1); // cleans up the file it just uploaded
  });

  it("stale_version (including a DIFFERENT file racing for an already-replaced upload): orphaned file cleaned up, retryable", async () => {
    supa.getUser.mockResolvedValueOnce({ data: { user: { id: "owner-1" } } });
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.remove.mockResolvedValueOnce({ data: [{ name: "removed" }], error: null });
    supa.rpc.mockResolvedValueOnce(retireRow("stale_version"));
    const { retireUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try { await retireUpload(TARGET, FILE); } catch (e) { caught = e; }
    const err = caught as InstanceType<typeof DiscardError>;
    expect(err.code).toBe("stale_version");
    expect(err.retryable).toBe(true);
    expect(supa.remove).toHaveBeenCalledTimes(1);
  });

  it("idempotent retry with the same file: the server returns the SAME new_upload_id", async () => {
    supa.getUser.mockResolvedValueOnce({ data: { user: { id: "owner-1" } } });
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.rpc.mockResolvedValueOnce(retireRow("replaced", { new_upload_id: "u2-existing", retired_upload_id: "u1" }));
    const { retireUpload } = await import("./DiscardUploadDialog");

    const result = await retireUpload(TARGET, FILE);
    expect(result.newUploadId).toBe("u2-existing");
  });

  it("any non-'replaced' outcome removes the just-uploaded object, so no orphan is left and no false success is reported", async () => {
    supa.getUser.mockResolvedValueOnce({ data: { user: { id: "owner-1" } } });
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.remove.mockResolvedValueOnce({ data: [{ name: "removed" }], error: null });
    supa.rpc.mockResolvedValueOnce(retireRow("already_discarded"));
    const { retireUpload } = await import("./DiscardUploadDialog");
    await expect(retireUpload(TARGET, FILE)).rejects.toMatchObject({ retryable: false });
    expect(supa.remove).toHaveBeenCalledTimes(1);
  });

  it("if the Storage upload itself fails, no RPC is called and nothing is changed (cancel before Storage upload: nothing to cancel)", async () => {
    supa.getUser.mockResolvedValueOnce({ data: { user: { id: "owner-1" } } });
    supa.upload.mockResolvedValueOnce({ data: null, error: { message: "network error" } });
    const { retireUpload, DiscardError } = await import("./DiscardUploadDialog");

    await expect(retireUpload(TARGET, FILE)).rejects.toBeInstanceOf(DiscardError);
    expect(supa.rpc).not.toHaveBeenCalled();
  });
});

describe("isCertifiedRun — prefers lifecycle_state when present", () => {
  it("lifecycle_state drives the decision when present, regardless of status/is_valid", async () => {
    const { isCertifiedRun } = await import("./DiscardUploadDialog");
    expect(isCertifiedRun({ id: "1", file_name: "x", lifecycle_state: "active_unprocessed", status: "complete", is_valid: true })).toBe(false);
    expect(isCertifiedRun({ id: "1", file_name: "x", lifecycle_state: "blocked" })).toBe(true);
    expect(isCertifiedRun({ id: "1", file_name: "x", lifecycle_state: "active_processed" })).toBe(true);
  });

  it("falls back to status/is_valid when lifecycle_state is absent (pre-migration callers)", async () => {
    const { isCertifiedRun } = await import("./DiscardUploadDialog");
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "complete", is_valid: null })).toBe(true);
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "needs_review", is_valid: false })).toBe(false);
    expect(isCertifiedRun(null)).toBe(false);
    expect(isCertifiedRun(undefined)).toBe(false);
  });
});

describe("restoreUpload — truthful Undo through restore_trial_balance_upload()", () => {
  const blob = new Blob(["contents"]);
  const receipt = { id: "u1", fileName: "tb.xlsx", operationId: "op1", row: { id: "u1" }, filePath: "owner-1/tb.xlsx", fileBlob: blob };
  const restoreRow = (outcome: string, upload_id: string | null = null) => ({ data: [{ outcome, upload_id, detail: null }], error: null });

  it("restored: re-uploads the file, then the server itself checks Storage (no claim is sent)", async () => {
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.rpc.mockResolvedValueOnce(restoreRow("restored", "u1"));
    const { restoreUpload } = await import("./DiscardUploadDialog");
    await expect(restoreUpload(receipt)).resolves.toEqual({ outcome: "restored", message: null });
    expect(supa.rpc).toHaveBeenCalledWith("restore_trial_balance_upload", { p_operation_id: "op1" });
  });

  it("EXACT SCENARIO: discard → new active upload → Undo = conflict_new_active_upload; re-uploaded file removed again; no success", async () => {
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.remove.mockResolvedValueOnce({ data: [], error: null });
    supa.rpc.mockResolvedValueOnce(restoreRow("conflict_new_active_upload"));
    const { restoreUpload } = await import("./DiscardUploadDialog");
    const r = await restoreUpload(receipt);
    expect(r.outcome).toBe("conflict_new_active_upload");
    expect(r.message).toMatch(/new trial balance is now active/i);
    expect(supa.remove).toHaveBeenCalledWith(["owner-1/tb.xlsx"]);
  });

  it("a Postgres unique-violation is NEVER read as 'already restored' — only the server's named outcome counts", async () => {
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.remove.mockResolvedValueOnce({ data: [], error: null });
    supa.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
    const { restoreUpload } = await import("./DiscardUploadDialog");
    expect((await restoreUpload(receipt)).outcome).toBe("terminal_failure");
    expect(supa.insert).not.toHaveBeenCalled();
  });

  it("no file bytes captured: the server answers storage_restore_required (nothing is claimed)", async () => {
    supa.rpc.mockResolvedValueOnce(restoreRow("storage_restore_required"));
    const { restoreUpload } = await import("./DiscardUploadDialog");
    expect((await restoreUpload({ ...receipt, fileBlob: null })).outcome).toBe("storage_restore_required");
    expect(supa.upload).not.toHaveBeenCalled();
  });

  it("no operation id: stale_operation, no server call", async () => {
    const { restoreUpload } = await import("./DiscardUploadDialog");
    expect((await restoreUpload({ ...receipt, operationId: null })).outcome).toBe("stale_operation");
    expect(supa.rpc).not.toHaveBeenCalled();
  });

  it("every refusal outcome has a plain-language message", async () => {
    const { restoreOutcomeMessage } = await import("./DiscardUploadDialog");
    for (const o of ["conflict_new_active_upload", "expired", "forbidden", "storage_restore_required", "stale_operation", "terminal_failure"] as const) {
      expect(restoreOutcomeMessage(o).length).toBeGreaterThan(10);
    }
  });
});

describe("offerUndo — a success toast only for restored / already_restored", () => {
  it("conflict: shows the conflict as an error and never a 'restored' success", async () => {
    const toastMod = await import("sonner");
    const success = vi.spyOn(toastMod.toast, "success").mockImplementation(() => "t1");
    const error = vi.spyOn(toastMod.toast, "error").mockImplementation(() => "t2");
    const dismiss = vi.spyOn(toastMod.toast, "dismiss").mockImplementation(() => "t1");
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.remove.mockResolvedValueOnce({ data: [], error: null });
    supa.rpc.mockResolvedValueOnce({ data: [{ outcome: "conflict_new_active_upload", upload_id: null, detail: null }], error: null });
    const { offerUndo } = await import("./DiscardUploadDialog");
    const onRestored = vi.fn();
    offerUndo({ id: "u1", fileName: "tb.xlsx", operationId: "op1", row: {}, filePath: "owner-1/tb.xlsx", fileBlob: new Blob(["x"]) }, onRestored);
    const opts = success.mock.calls[0][1] as { action: { onClick: () => void } };
    opts.action.onClick();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(String(error.mock.calls[0][0])).toMatch(/new trial balance is now active/i);
    expect(success).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();
    success.mockRestore(); error.mockRestore(); dismiss.mockRestore();
  });
});

describe("cancelReplacement — restores the predecessor; the Edge Function removes the file (server-verified)", () => {
  const REPLACEMENT = { ...TARGET, id: "rep1", replaces_upload_id: "u0", lifecycle_state: "active_unprocessed" };
  const cancelRow = (outcome: string, extra: Record<string, unknown> = {}) =>
    ({ data: [{ outcome, operation_id: null, restored_upload_id: null, file_path: null, detail: null, ...extra }], error: null });

  it("cancelled: the Edge Function completes the Storage cleanup", async () => {
    supa.rpc.mockResolvedValueOnce(cancelRow("cancelled", { operation_id: "c1", restored_upload_id: "u0", file_path: "collaborator-9/rep.csv" }));
    supa.invoke.mockResolvedValueOnce(cleanupOk("completed"));
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).resolves.toEqual({ restoredUploadId: "u0", storageCleanupPending: false });
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-storage-cleanup", { body: { operation_id: "c1" } });
    expect(supa.remove).not.toHaveBeenCalled();
  });

  it("a Storage-cleanup failure is reported as pending (the database state is already correct)", async () => {
    supa.rpc.mockResolvedValueOnce(cancelRow("cancelled", { operation_id: "c1", restored_upload_id: "u0", file_path: "x/rep.csv" }));
    supa.invoke.mockResolvedValueOnce(cleanupHttpError("storage_cleanup_pending"));
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).resolves.toEqual({ restoredUploadId: "u0", storageCleanupPending: true });
  });

  it("retry after a lost response: already_cancelled retries the cleanup", async () => {
    supa.rpc.mockResolvedValueOnce(cancelRow("already_cancelled", { operation_id: "c1", restored_upload_id: "u0", file_path: "x/rep.csv" }));
    supa.invoke.mockResolvedValueOnce(cleanupOk("already_completed"));
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).resolves.toEqual({ restoredUploadId: "u0", storageCleanupPending: false });
  });

  it("a replacement already processed cannot be cancelled: routed to Replace, no cleanup call", async () => {
    supa.rpc.mockResolvedValueOnce(cancelRow("replacement_processed"));
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).rejects.toMatchObject({ code: "replacement_required", retryable: false });
    expect(supa.invoke).not.toHaveBeenCalled();
  });

  it("forbidden and stale_version stay distinct", async () => {
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    supa.rpc.mockResolvedValueOnce(cancelRow("forbidden"));
    await expect(cancelReplacement(REPLACEMENT)).rejects.toMatchObject({ code: "forbidden", retryable: false });
    supa.rpc.mockResolvedValueOnce(cancelRow("stale_version"));
    await expect(cancelReplacement(REPLACEMENT)).rejects.toMatchObject({ code: "stale_version", retryable: true });
  });

  it("isUnprocessedReplacement only for an unprocessed upload that replaced another", async () => {
    const { isUnprocessedReplacement } = await import("./DiscardUploadDialog");
    expect(isUnprocessedReplacement(REPLACEMENT)).toBe(true);
    expect(isUnprocessedReplacement({ ...REPLACEMENT, lifecycle_state: "active_processing" })).toBe(false);
    expect(isUnprocessedReplacement({ ...REPLACEMENT, replaces_upload_id: null })).toBe(false);
  });
});

describe("20260923100000_upload_lifecycle_retire_and_replace.sql — structural proof", () => {
  const sql = readFileSync(join(__dirname, "../../../supabase/migrations/20260923100000_upload_lifecycle_retire_and_replace.sql"), "utf8");
  const fn = (name: string) => {
    const a = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return sql.slice(a, sql.indexOf("$$;", sql.indexOf("AS $$", a)) + 3);
  };

  it("defines the full lifecycle vocabulary and fails closed via an explicit CHECK constraint", () => {
    for (const state of ["active_unprocessed", "active_processing", "active_processed", "blocked", "retired", "superseded", "discard_pending", "discarded"]) {
      expect(sql).toContain(`'${state}'`);
    }
    expect(sql).toMatch(/chk_tbu_lifecycle_state CHECK/);
  });

  it("never touches the append-only certification guard or the CASCADE FK", () => {
    expect(sql).not.toMatch(/ALTER TABLE public\.tb_certifications[\s\S]*?DROP TRIGGER/);
    expect(sql).not.toMatch(/DISABLE TRIGGER/);
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]*?fk_tbc_upload/);
  });

  it("USER-BASED authority: the predicate is ownership or an explicit grant, and never reads firm_members or a title", () => {
    const pred = fn("workspace_authority_basis");
    expect(pred).toMatch(/c\.user_id = p_user_id/);
    expect(pred).toMatch(/workspace_capability_grants/);
    expect(pred).toMatch(/revoked_at IS NULL/);
    expect(pred).not.toMatch(/firm_members|partner|manager|preparer|'owner'/);
    expect(sql).not.toMatch(/fm\.role IN/);
    expect(sql).not.toMatch(/tbu_source_manager_membership/);
  });

  it("every lifecycle RPC authorizes through tbu_authorize (manage_source_files) and audits denials", () => {
    for (const name of ["discard_trial_balance_upload", "complete_trial_balance_discard", "restore_trial_balance_upload", "retire_trial_balance_upload", "cancel_trial_balance_replacement", "confirm_trial_balance_storage_cleanup"]) {
      expect(fn(name), name).toMatch(/tbu_authorize\(/);
    }
    expect(fn("discard_trial_balance_upload")).toMatch(/'denied'/);
  });

  it("capability storage: DB-enforced values, one active grant, owner-only grant/revoke, immutable revocation, audit", () => {
    expect(sql).toMatch(/capability IN \('manage_source_files', 'prepare_trial_balance', 'review_close', 'administer_workspace'\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_wcg_one_active_grant[\s\S]*?WHERE revoked_at IS NULL/);
    expect(fn("grant_workspace_capability")).toMatch(/v_owner <> auth\.uid\(\)/);
    expect(fn("revoke_workspace_capability")).toMatch(/v_owner <> auth\.uid\(\)/);
    expect(sql).toMatch(/workspace_capability_grant_events/);
  });

  it("actor identity: actor_user_id is the identity; membership is nullable metadata; authority basis is recorded", () => {
    expect(sql).toMatch(/actor_membership_id uuid,\s+-- nullable compatibility metadata/);
    expect(sql).toMatch(/authority_basis text NOT NULL CHECK \(authority_basis IN \('workspace_owner', 'explicit_capability'\)\)/);
    expect(sql).not.toMatch(/actor_membership_id uuid NOT NULL/);
  });

  it("Storage evidence is read by the server; no RPC accepts a client removed/restored claim", () => {
    expect(sql).not.toMatch(/p_storage_removed|p_storage_restored/);
    expect(fn("complete_trial_balance_discard")).toMatch(/tbu_storage_object_exists/);
    expect(fn("restore_trial_balance_upload")).toMatch(/tbu_storage_object_exists/);
    expect(fn("confirm_trial_balance_storage_cleanup")).toMatch(/tbu_storage_object_exists/);
  });

  it("an operation may only delete a path bound to its own upload (uploader folder, not shared)", () => {
    const b = fn("tbu_bound_storage_path");
    expect(b).toMatch(/split_part\(p_upload\.file_path, '\/', 1\) <> p_upload\.user_id::text/);
    expect(b).toMatch(/t\.id <> p_upload\.id/);
    expect(fn("retire_trial_balance_upload")).toMatch(/split_part\(p_new_file_path, '\/', 1\) <> auth\.uid\(\)::text/);
  });

  it("B1: the backfill uses the pre-lifecycle authority order and fails closed before the index", () => {
    expect(sql).toMatch(/ORDER BY uploaded_at DESC, id DESC\) AS rn/);
    expect(sql.indexOf("still have more than one active upload")).toBeLessThan(sql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_upload_per_period"));
  });

  it("grants: client RPCs to authenticated only; the predicate and storage helpers to service_role only", () => {
    for (const f of ["discard_trial_balance_upload(uuid, bigint)", "complete_trial_balance_discard(uuid)", "restore_trial_balance_upload(uuid)",
      "retire_trial_balance_upload(uuid, bigint, text, text, integer, text)", "cancel_trial_balance_replacement(uuid, bigint)", "confirm_trial_balance_storage_cleanup(uuid)",
      "grant_workspace_capability(uuid, uuid, text)", "revoke_workspace_capability(uuid, uuid, text)"]) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO authenticated`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon`);
    }
    for (const f of ["can_user_act_on_workspace(uuid, uuid, text)", "tbu_storage_object_exists(text)", "tbu_storage_cleanup_target(uuid)"]) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated`);
    }
  });
});
