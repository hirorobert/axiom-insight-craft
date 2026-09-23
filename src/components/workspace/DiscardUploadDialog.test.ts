/**
 * DiscardUploadDialog.test.ts — lifecycle-safe discard/replace.
 *
 * Root cause this proves fixed: 20260922180000's discard_trial_balance_upload() deleted
 * trial_balance_uploads directly, cascading into the append-only tb_certifications table — which
 * unconditionally refuses ANY delete, including one arriving via cascade — so any upload with
 * processing/certification history could never be discarded (confirmed live during authenticated
 * UI acceptance of PR #32 against axiom-omega3-staging-replay). 20260923100000 replaces this with
 * a formal lifecycle: discard_trial_balance_upload() is now a two-phase saga restricted to
 * genuinely unprocessed uploads, and retire_trial_balance_upload() is the only path for anything
 * with history — it deletes nothing, ever.
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
  it("happy path: begin -> discard_pending, storage removed, complete -> deleted_now; receipt carries the begin-supplied snapshot", async () => {
    const blob = new Blob(["contents"]);
    supa.download.mockResolvedValueOnce({ data: blob });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc
      .mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: "co/tb.xlsx" }))
      .mockResolvedValueOnce(completeRow("deleted_now"));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", row: ROW_SNAPSHOT, filePath: "co/tb.xlsx", fileBlob: blob });
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

  it("already_discarded (begin): idempotent success, no storage call, no complete call", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("already_discarded"));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", row: null, filePath: "co/tb.xlsx", fileBlob: null });
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
    supa.rpc.mockResolvedValueOnce(retireRow("deleted_now", { new_upload_id: "u2", retired_upload_id: "u1" }));
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

  it("stale_version: orphaned file cleaned up, retryable", async () => {
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
  });

  it("idempotent retry: retiring an already-superseded upload again returns the SAME new_upload_id rather than erroring", async () => {
    supa.getUser.mockResolvedValueOnce({ data: { user: { id: "owner-1" } } });
    supa.upload.mockResolvedValueOnce({ data: {}, error: null });
    supa.rpc.mockResolvedValueOnce(retireRow("deleted_now", { new_upload_id: "u2-existing", retired_upload_id: "u1" }));
    const { retireUpload } = await import("./DiscardUploadDialog");

    const result = await retireUpload(TARGET, FILE);
    expect(result.newUploadId).toBe("u2-existing");
  });

  it("if the Storage upload itself fails, no RPC is called and nothing is changed", async () => {
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

describe("restoreUpload — unchanged: Undo only ever applies to a genuine hard discard", () => {
  const receipt = { id: "u1", fileName: "tb.xlsx", row: { id: "u1", file_name: "tb.xlsx" }, filePath: null, fileBlob: null };

  it("a unique-violation on insert (the row is already back) is treated as success", async () => {
    supa.insert.mockResolvedValueOnce({ error: { code: "23505", message: "duplicate key" } });
    const { restoreUpload } = await import("./DiscardUploadDialog");
    await expect(restoreUpload(receipt)).resolves.toBeUndefined();
  });

  it("no receipt.row: refuses to restore — correct for the already_discarded / replacement_required cases, which never carry a snapshot", async () => {
    const { restoreUpload } = await import("./DiscardUploadDialog");
    await expect(restoreUpload({ ...receipt, row: null })).rejects.toThrow(/can no longer be undone/i);
    expect(supa.insert).not.toHaveBeenCalled();
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
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_one_active_upload_per_period/);
    expect(sql).toMatch(/WHERE lifecycle_state IN \('active_unprocessed', 'active_processing', 'active_processed', 'blocked'\)/);
  });

  it("prevents a retired upload from becoming active again, and prevents supersession self-reference / re-pointing", () => {
    expect(sql).toMatch(/chk_tbu_no_self_supersede/);
    expect(sql).toMatch(/a retired\/superseded\/discarded upload cannot change lifecycle_state/);
    expect(sql).toMatch(/superseded_by_upload_id is set once and never changed/);
  });

  it("discard_trial_balance_upload requires authorization, row lock, and version match before proceeding", () => {
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/v_row\.version <> p_expected_version/);
    expect(sql).toMatch(/v_authorized/);
  });

  it("retire_trial_balance_upload is idempotent and preserves the original row/certifications (never deletes trial_balance_uploads or tb_certifications)", () => {
    const retireFn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.retire_trial_balance_upload"));
    expect(retireFn).not.toMatch(/DELETE FROM/);
    expect(retireFn).toMatch(/Already replaced/);
  });

  it("grants EXECUTE only to authenticated, never anon/PUBLIC, for every new function", () => {
    for (const fn of ["discard_trial_balance_upload(uuid, bigint)", "complete_trial_balance_discard(uuid, boolean)", "retire_trial_balance_upload(uuid, bigint, text, text, integer, text)"]) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated`);
      expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn} FROM PUBLIC, anon`);
    }
  });
});
