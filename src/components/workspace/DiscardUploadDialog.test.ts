/**
 * DiscardUploadDialog.test.ts — lifecycle-safe discard / replace / cancel / Undo (client contract).
 *
 * Root cause this proves fixed: 20260922180000's discard_trial_balance_upload() deleted
 * trial_balance_uploads directly, cascading into the append-only tb_certifications table. That table
 * unconditionally refuses ANY delete, including one arriving via cascade, so any upload with
 * processing/certification history could never be discarded (confirmed live during authenticated UI
 * acceptance of PR #32 against axiom-omega3-staging-replay). 20260923100000 replaces this with a formal
 * lifecycle:
 *   - discard_trial_balance_upload() is a two-phase saga, restricted to genuinely unprocessed uploads;
 *   - retire_trial_balance_upload() is the only path for anything with history, and deletes nothing;
 *   - cancel_trial_balance_replacement() removes an unprocessed replacement and restores its predecessor;
 *   - restore_trial_balance_upload() answers Undo with an explicit outcome.
 * The behaviour against a real database is proven by scripts/db-proof/uploadLifecycle.mjs; these tests
 * pin the client contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const supa = vi.hoisted(() => ({
  rpc: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  insert: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string, args: unknown) => supa.rpc(name, args),
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

const TARGET = { id: "u1", file_name: "tb.xlsx", file_path: "co/tb.xlsx", status: "needs_review", is_valid: null, version: 1 };
const ROW_SNAPSHOT = { id: "u1", file_name: "tb.xlsx", status: "needs_review" };

function beginRow(outcome: string, extra: Partial<{ operation_id: string; row_snapshot: unknown; file_path: string | null; detail: string | null }> = {}) {
  return { data: [{ outcome, operation_id: null, row_snapshot: null, file_path: null, detail: null, ...extra }], error: null };
}
function completeRow(outcome: string, detail: string | null = null) {
  return { data: [{ outcome, detail }], error: null };
}
function retireRow(outcome: string, extra: Partial<{ new_upload_id: string; retired_upload_id: string; detail: string | null }> = {}) {
  return { data: [{ outcome, new_upload_id: null, retired_upload_id: null, detail: null, ...extra }], error: null };
}

describe("discardUpload — the two-phase saga, restricted to genuinely unprocessed uploads", () => {
  it("happy path: begin -> discard_pending, storage removed, complete -> deleted_now; receipt carries the operation id and snapshot", async () => {
    const blob = new Blob(["contents"]);
    supa.download.mockResolvedValueOnce({ data: blob });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc
      .mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "co/tb.xlsx" }))
      .mockResolvedValueOnce(completeRow("deleted_now"));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", operationId: "op1", row: ROW_SNAPSHOT, filePath: "co/tb.xlsx", fileBlob: blob });
    expect(supa.rpc).toHaveBeenNthCalledWith(1, "discard_trial_balance_upload", { p_upload_id: "u1", p_expected_version: 1 });
    expect(supa.remove).toHaveBeenCalledWith(["co/tb.xlsx"]);
    expect(supa.rpc).toHaveBeenNthCalledWith(2, "complete_trial_balance_discard", { p_operation_id: "op1", p_storage_removed: true });
  });

  it("never reports success while Storage cleanup is unknown: a remove() failure passes p_storage_removed=false and the whole call fails, retryable", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.remove.mockResolvedValueOnce({ data: null, error: { message: "network error" } });
    supa.rpc
      .mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "co/tb.xlsx" }))
      .mockResolvedValueOnce(completeRow("discard_pending", "Storage removal has not been confirmed yet."));
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try { await discardUpload(TARGET); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DiscardError);
    expect((caught as InstanceType<typeof DiscardError>).retryable).toBe(true);
    expect(supa.rpc).toHaveBeenNthCalledWith(2, "complete_trial_balance_discard", { p_operation_id: "op1", p_storage_removed: false });
  });

  it("resume: a retried begin call for an upload already discard_pending returns the SAME operation_id, never starts a second one", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc
      .mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op-existing", row_snapshot: ROW_SNAPSHOT, file_path: "co/tb.xlsx", detail: "Resuming a previously started discard." }))
      .mockResolvedValueOnce(completeRow("deleted_now"));
    const { discardUpload } = await import("./DiscardUploadDialog");

    await discardUpload(TARGET);
    expect(supa.rpc).toHaveBeenNthCalledWith(2, "complete_trial_balance_discard", { p_operation_id: "op-existing", p_storage_removed: true });
  });

  it("already_discarded (begin): idempotent success, no storage call, no complete call, no undo operation", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("already_discarded"));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", operationId: null, row: null, filePath: "co/tb.xlsx", fileBlob: null });
    expect(supa.download).not.toHaveBeenCalled();
    expect(supa.remove).not.toHaveBeenCalled();
    expect(supa.rpc).toHaveBeenCalledTimes(1);
  });

  it("replacement_required — THE ROOT-CAUSE CASE: an upload with processing/certification history is refused with a distinct, named outcome, never a generic retryable failure", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("replacement_required", { detail: "This trial balance has certification history and cannot be deleted. Upload a replacement instead." }));
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try { await discardUpload(TARGET); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DiscardError);
    const err = caught as InstanceType<typeof DiscardError>;
    expect(err.code).toBe("replacement_required");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/replacement/i);
    expect(supa.download).not.toHaveBeenCalled();
  });

  it("the server decides eligibility: a target the client believed unprocessed still gets replacement_required, and nothing is removed", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("replacement_required"));
    const { discardUpload, isCertifiedRun } = await import("./DiscardUploadDialog");
    const stale = { ...TARGET, lifecycle_state: "active_unprocessed" };
    expect(isCertifiedRun(stale)).toBe(false);
    await expect(discardUpload(stale)).rejects.toMatchObject({ code: "replacement_required" });
    expect(supa.download).not.toHaveBeenCalled();
    expect(supa.remove).not.toHaveBeenCalled();
  });

  it("evidence appearing during the saga (complete -> replacement_required) is surfaced as replacement_required", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc
      .mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "co/tb.xlsx" }))
      .mockResolvedValueOnce(completeRow("replacement_required"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "replacement_required", retryable: false });
  });

  it("replacement_cancel_required: an unprocessed replacement is routed to Cancel replacement, never deleted", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("replacement_cancel_required"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "replacement_cancel_required", retryable: false });
    expect(supa.remove).not.toHaveBeenCalled();
  });

  it("stale_version: distinct, retryable outcome (caller should refresh and retry, not treat it as forbidden)", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("stale_version"));
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try { await discardUpload(TARGET); } catch (e) { caught = e; }
    const err = caught as InstanceType<typeof DiscardError>;
    expect(err.code).toBe("stale_version");
    expect(err.retryable).toBe(true);
  });

  it("forbidden and dependency_conflict remain distinct, non-retryable outcomes", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("forbidden"));
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");
    let caught: unknown;
    try { await discardUpload(TARGET); } catch (e) { caught = e; }
    expect((caught as InstanceType<typeof DiscardError>).code).toBe("forbidden");
    expect((caught as InstanceType<typeof DiscardError>).retryable).toBe(false);

    supa.rpc.mockResolvedValueOnce(beginRow("dependency_conflict"));
    let caught2: unknown;
    try { await discardUpload(TARGET); } catch (e) { caught2 = e; }
    expect((caught2 as InstanceType<typeof DiscardError>).code).toBe("dependency_conflict");
  });

  it("a target with no file_path skips storage entirely and still finalizes", async () => {
    supa.rpc
      .mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: null }))
      .mockResolvedValueOnce(completeRow("deleted_now"));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload({ ...TARGET, file_path: null });
    expect(supa.download).not.toHaveBeenCalled();
    expect(supa.remove).not.toHaveBeenCalled();
    expect(receipt.fileBlob).toBeNull();
    expect(supa.rpc).toHaveBeenNthCalledWith(2, "complete_trial_balance_discard", { p_operation_id: "op1", p_storage_removed: true });
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
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
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
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
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
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
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
  const receipt = { id: "u1", fileName: "tb.xlsx", operationId: "op1", row: { id: "u1" }, filePath: "co/tb.xlsx", fileBlob: blob };
  const restoreRow = (outcome: string, upload_id: string | null = null) => ({ data: [{ outcome, upload_id, detail: null }], error: null });

  it("restored: re-uploads the file first, tells the server truthfully, reports success", async () => {
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.rpc.mockResolvedValueOnce(restoreRow("restored", "u1"));
    const { restoreUpload } = await import("./DiscardUploadDialog");
    await expect(restoreUpload(receipt)).resolves.toEqual({ outcome: "restored", message: null });
    expect(supa.rpc).toHaveBeenCalledWith("restore_trial_balance_upload", { p_operation_id: "op1", p_storage_restored: true });
    expect(supa.remove).not.toHaveBeenCalled();
  });

  it("EXACT SCENARIO: discard -> new active upload -> Undo = conflict_new_active_upload; the re-uploaded file is removed again; no success", async () => {
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc.mockResolvedValueOnce(restoreRow("conflict_new_active_upload"));
    const { restoreUpload } = await import("./DiscardUploadDialog");
    const r = await restoreUpload(receipt);
    expect(r.outcome).toBe("conflict_new_active_upload");
    expect(r.message).toMatch(/new trial balance is now active/i);
    expect(supa.remove).toHaveBeenCalledWith(["co/tb.xlsx"]);
  });

  it("a Postgres unique-violation is NEVER read as 'already restored' — only the server's named outcome counts", async () => {
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
    const { restoreUpload } = await import("./DiscardUploadDialog");
    const r = await restoreUpload(receipt);
    expect(r.outcome).toBe("terminal_failure");
    expect(supa.insert).not.toHaveBeenCalled();
  });

  it("no file bytes captured: the server is told Storage was NOT restored and answers storage_restore_required", async () => {
    supa.rpc.mockResolvedValueOnce(restoreRow("storage_restore_required"));
    const { restoreUpload } = await import("./DiscardUploadDialog");
    const r = await restoreUpload({ ...receipt, fileBlob: null });
    expect(r.outcome).toBe("storage_restore_required");
    expect(supa.rpc).toHaveBeenCalledWith("restore_trial_balance_upload", { p_operation_id: "op1", p_storage_restored: false });
    expect(supa.upload).not.toHaveBeenCalled();
  });

  it("no operation id (nothing was discarded by this call): stale_operation, no server call", async () => {
    const { restoreUpload } = await import("./DiscardUploadDialog");
    const r = await restoreUpload({ ...receipt, operationId: null });
    expect(r.outcome).toBe("stale_operation");
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
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc.mockResolvedValueOnce({ data: [{ outcome: "conflict_new_active_upload", upload_id: null, detail: null }], error: null });
    const { offerUndo } = await import("./DiscardUploadDialog");
    const onRestored = vi.fn();
    offerUndo({ id: "u1", fileName: "tb.xlsx", operationId: "op1", row: {}, filePath: "co/tb.xlsx", fileBlob: new Blob(["x"]) }, onRestored);
    const opts = success.mock.calls[0][1] as { action: { onClick: () => void } };
    opts.action.onClick();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(String(error.mock.calls[0][0])).toMatch(/new trial balance is now active/i);
    expect(success).toHaveBeenCalledTimes(1); // only the original "Discarded …" toast
    expect(onRestored).not.toHaveBeenCalled();
    success.mockRestore(); error.mockRestore(); dismiss.mockRestore();
  });
});

describe("cancelReplacement — restores the predecessor; Storage cleanup is recorded, never hidden", () => {
  const REPLACEMENT = { ...TARGET, id: "rep1", replaces_upload_id: "u0", lifecycle_state: "active_unprocessed" };
  const cancelRow = (outcome: string, extra: Record<string, unknown> = {}) =>
    ({ data: [{ outcome, operation_id: null, restored_upload_id: null, file_path: null, detail: null, ...extra }], error: null });

  it("cancelled (after Storage upload, before processing): removes the replacement file and confirms the cleanup", async () => {
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc
      .mockResolvedValueOnce(cancelRow("cancelled", { operation_id: "c1", restored_upload_id: "u0", file_path: "co/rep.csv" }))
      .mockResolvedValueOnce({ data: [{ outcome: "completed", detail: null }], error: null });
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).resolves.toEqual({ restoredUploadId: "u0", storageCleanupPending: false });
    expect(supa.rpc).toHaveBeenNthCalledWith(1, "cancel_trial_balance_replacement", { p_replacement_upload_id: "rep1", p_expected_version: 1 });
    expect(supa.rpc).toHaveBeenNthCalledWith(2, "confirm_trial_balance_storage_cleanup", { p_operation_id: "c1", p_storage_removed: true });
  });

  it("a Storage-cleanup failure is reported as pending (the database state is already correct)", async () => {
    supa.remove.mockResolvedValueOnce({ data: null, error: { message: "network" } });
    supa.rpc
      .mockResolvedValueOnce(cancelRow("cancelled", { operation_id: "c1", restored_upload_id: "u0", file_path: "co/rep.csv" }))
      .mockResolvedValueOnce({ data: [{ outcome: "storage_cleanup_pending", detail: null }], error: null });
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).resolves.toEqual({ restoredUploadId: "u0", storageCleanupPending: true });
    expect(supa.rpc).toHaveBeenNthCalledWith(2, "confirm_trial_balance_storage_cleanup", { p_operation_id: "c1", p_storage_removed: false });
  });

  it("retry after a lost response: already_cancelled retries the cleanup and succeeds", async () => {
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc
      .mockResolvedValueOnce(cancelRow("already_cancelled", { operation_id: "c1", restored_upload_id: "u0", file_path: "co/rep.csv" }))
      .mockResolvedValueOnce({ data: [{ outcome: "already_completed", detail: null }], error: null });
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).resolves.toEqual({ restoredUploadId: "u0", storageCleanupPending: false });
  });

  it("a replacement already processed cannot be cancelled: routed to Replace (code replacement_required), nothing removed", async () => {
    supa.rpc.mockResolvedValueOnce(cancelRow("replacement_processed"));
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).rejects.toMatchObject({ code: "replacement_required", retryable: false });
    expect(supa.remove).not.toHaveBeenCalled();
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

  it("defines the full lifecycle vocabulary and fails closed via an explicit CHECK constraint", () => {
    for (const state of ["active_unprocessed", "active_processing", "active_processed", "blocked", "retired", "superseded", "discard_pending", "discarded"]) {
      expect(sql).toContain(`'${state}'`);
    }
    expect(sql).toMatch(/chk_tbu_lifecycle_state CHECK/);
  });

  it("never adds an ON DELETE CASCADE exception that erases certifications, and does not touch the append-only guard", () => {
    expect(sql).not.toMatch(/ALTER TABLE public\.tb_certifications[\s\S]*?DROP TRIGGER/);
    expect(sql).not.toMatch(/DISABLE TRIGGER/);
    // fk_tbc_upload (the original CASCADE FK) is only ever mentioned in the doc comment explaining
    // the root cause — never altered, dropped, or referenced in any executable statement.
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]*?fk_tbc_upload/);
    expect(sql).not.toMatch(/DROP CONSTRAINT[\s\S]{0,40}fk_tbc_upload/);
  });

  it("enforces at most one active upload per engagement/period via a real database constraint", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_upload_per_period/);
    expect(sql).toMatch(/WHERE lifecycle_state IN \('active_unprocessed', 'active_processing', 'active_processed', 'blocked'\)/);
  });

  it("prevents a retired upload from becoming active again, and prevents supersession self-reference / re-pointing", () => {
    expect(sql).toMatch(/chk_tbu_no_self_supersede/);
    expect(sql).toMatch(/a retired\/superseded\/discarded upload cannot change lifecycle_state/);
    expect(sql).toMatch(/superseded_by_upload_id is set once and only cleared by cancel_trial_balance_replacement/);
  });

  it("discard_trial_balance_upload requires the owner/partner capability, a row lock, evidence checks and a version match", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.discard_trial_balance_upload"), sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_trial_balance_discard"));
    expect(fn).toMatch(/FOR UPDATE/);
    expect(fn).toMatch(/v_row\.version <> p_expected_version/);
    expect(fn).toMatch(/tbu_source_manager_membership/);
    expect(fn).toMatch(/tbu_upload_evidence/);
    expect(sql).toMatch(/fm\.role IN \('owner', 'partner', 'manager'\)/);
  });

  it("B1: the backfill uses the pre-lifecycle authority order, retires without inventing lineage, and fails closed before the index", () => {
    expect(sql).toMatch(/ORDER BY uploaded_at DESC, id DESC\) AS rn/);
    expect(sql).toMatch(/Retired with no inferred successor/);
    const assertion = sql.indexOf("still have more than one active upload");
    expect(assertion).toBeGreaterThan(0);
    expect(assertion).toBeLessThan(sql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_upload_per_period"));
  });

  it("B2: certification drives lifecycle from the database (AFTER INSERT ON tb_certifications)", () => {
    expect(sql).toMatch(/AFTER INSERT ON public\.tb_certifications/);
    expect(sql).toMatch(/CASE WHEN NEW\.is_blocking THEN 'blocked' ELSE 'active_processed' END/);
  });

  it("actor identity: lifecycle events and operations record both the auth user and the firm membership", () => {
    expect(sql).toMatch(/actor_user_id uuid/);
    expect(sql).toMatch(/actor_membership_id uuid/);
  });

  it("retire_trial_balance_upload is idempotent and preserves the original row/certifications (never deletes trial_balance_uploads or tb_certifications)", () => {
    const retireFn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.retire_trial_balance_upload"), sql.indexOf("CREATE OR REPLACE FUNCTION public.cancel_trial_balance_replacement"));
    expect(retireFn).not.toMatch(/DELETE FROM/);
    expect(retireFn).toMatch(/Already replaced/);
  });

  it("grants EXECUTE only to authenticated, never anon/PUBLIC, for every client RPC", () => {
    for (const fn of ["discard_trial_balance_upload(uuid, bigint)", "complete_trial_balance_discard(uuid, boolean)", "retire_trial_balance_upload(uuid, bigint, text, text, integer, text)",
      "restore_trial_balance_upload(uuid, boolean)", "cancel_trial_balance_replacement(uuid, bigint)", "confirm_trial_balance_storage_cleanup(uuid, boolean)"]) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon`);
    }
  });
});
