/**
 * DiscardUploadDialog.test.ts — lifecycle-safe discard / replace / cancel / Undo (client contract).
 *
 * 20260923100000 gives trial balance uploads a formal lifecycle and USER-BASED authority (workspace owner or an
 * explicit manage_source_files grant; never a title or firm membership):
 *   - discard_trial_balance_upload() + complete_trial_balance_discard() remove the row of a genuinely unprocessed
 *     upload but RETAIN the source for the undo window;
 *   - restore_trial_balance_upload() restores the exact retained object, for any authorized user;
 *   - the source is purged only after the discard is terminal (trial-balance-storage-cleanup);
 *   - retire_trial_balance_upload() replaces an upload with history using a workspace-scoped reserved source;
 *   - cancel_trial_balance_replacement() removes an unprocessed replacement and restores its predecessor.
 * The real-database behaviour is proven by scripts/db-proof/uploadLifecycle.mjs, and end to end on hosted staging by
 * scripts/upload_lifecycle_staging.mjs. These tests pin the client contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const supa = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  uploadToSignedUrl: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string, args: unknown) => supa.rpc(name, args),
    functions: { invoke: (name: string, opts: unknown) => supa.invoke(name, opts) },
    storage: {
      from: () => ({
        uploadToSignedUrl: (p: string, t: string, f: unknown) => supa.uploadToSignedUrl(p, t, f),
        download: (p: string) => supa.download(p),
        remove: (p: string[]) => supa.remove(p),
        upload: (p: string, f: unknown, o: unknown) => supa.upload(p, f, o),
      }),
    },
  },
}));

afterEach(() => vi.clearAllMocks());

const TARGET = { id: "u1", file_name: "tb.xlsx", file_path: "workspaces/co-1/src-1/tb.xlsx", status: "processing", is_valid: null, version: 1, company_id: "co-1" };
const ROW_SNAPSHOT = { id: "u1", file_name: "tb.xlsx", status: "processing" };
const rows = (row: Record<string, unknown>) => ({ data: [row], error: null });
const beginRow = (outcome: string, extra: Record<string, unknown> = {}) => rows({ outcome, operation_id: null, row_snapshot: null, file_path: null, detail: null, ...extra });
const cleanupOk = (outcome: string) => ({ data: { outcome }, error: null });
const cleanupHttpError = (outcome: string) => ({ data: null, error: { message: "non-2xx", context: { json: async () => ({ outcome }) } } });

describe("discardUpload — the row goes, the source is RETAINED for Undo; no Storage call from the browser", () => {
  it("happy path: begin → complete; no download, no removal, no Edge Function; receipt carries the operation", async () => {
    supa.rpc
      .mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1", row_snapshot: ROW_SNAPSHOT, file_path: TARGET.file_path }))
      .mockResolvedValueOnce(rows({ outcome: "deleted_now", detail: null }));
    const { discardUpload } = await import("./DiscardUploadDialog");
    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", operationId: "op1", row: ROW_SNAPSHOT, filePath: TARGET.file_path });
    expect(supa.rpc).toHaveBeenNthCalledWith(1, "discard_trial_balance_upload", { p_upload_id: "u1", p_expected_version: 1 });
    expect(supa.rpc).toHaveBeenNthCalledWith(2, "complete_trial_balance_discard", { p_operation_id: "op1" });
    expect(supa.download).not.toHaveBeenCalled();
    expect(supa.remove).not.toHaveBeenCalled();
    expect(supa.invoke).not.toHaveBeenCalled();
  });

  it("resume: a retried begin reuses the SAME operation", async () => {
    supa.rpc
      .mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op-existing", row_snapshot: ROW_SNAPSHOT }))
      .mockResolvedValueOnce(rows({ outcome: "already_discarded", detail: null }));
    const { discardUpload } = await import("./DiscardUploadDialog");
    expect((await discardUpload(TARGET)).operationId).toBe("op-existing");
  });

  it("already_discarded (begin): idempotent, no completion, no undo operation", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("already_discarded"));
    const { discardUpload } = await import("./DiscardUploadDialog");
    expect(await discardUpload(TARGET)).toEqual({ id: "u1", fileName: "tb.xlsx", operationId: null, row: null, filePath: TARGET.file_path });
    expect(supa.rpc).toHaveBeenCalledTimes(1);
  });

  it("the server decides eligibility: replacement_required even when the client believed the upload unprocessed", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("replacement_required"));
    const { discardUpload, isCertifiedRun } = await import("./DiscardUploadDialog");
    const stale = { ...TARGET, lifecycle_state: "active_unprocessed" };
    expect(isCertifiedRun(stale)).toBe(false);
    await expect(discardUpload(stale)).rejects.toMatchObject({ code: "replacement_required", retryable: false });
  });

  it("evidence appearing mid-saga (complete → replacement_required) and a refused completion are surfaced with codes", async () => {
    const { discardUpload } = await import("./DiscardUploadDialog");
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1" })).mockResolvedValueOnce(rows({ outcome: "replacement_required", detail: null }));
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "replacement_required" });
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1" })).mockResolvedValueOnce(rows({ outcome: "forbidden", detail: null }));
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a completion transport error is retryable, never success", async () => {
    supa.rpc.mockResolvedValueOnce(beginRow("discard_pending", { operation_id: "op1" })).mockResolvedValueOnce({ data: null, error: { message: "network" } });
    const { discardUpload } = await import("./DiscardUploadDialog");
    await expect(discardUpload(TARGET)).rejects.toMatchObject({ retryable: true });
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

describe("retireUpload — workspace-scoped replacement through a server reservation (no client-chosen path)", () => {
  const FILE = new File(["contents"], "replacement.csv", { type: "text/csv" });
  const reserveOk = () => rows({ outcome: "reserved", reservation_id: "res-1", object_path: "workspaces/co-1/src-9/replacement.csv" });
  const signOk = () => ({ data: { outcome: "signed", path: "workspaces/co-1/src-9/replacement.csv", token: "tok" }, error: null });

  it("reserve → signed upload of exactly that object → retire with the reservation", async () => {
    supa.rpc.mockResolvedValueOnce(reserveOk()).mockResolvedValueOnce(rows({ outcome: "replaced", new_upload_id: "u2", retired_upload_id: "u1", detail: null }));
    supa.invoke.mockResolvedValueOnce(signOk());
    supa.uploadToSignedUrl.mockResolvedValueOnce({ data: {}, error: null });
    const { retireUpload } = await import("./DiscardUploadDialog");
    await expect(retireUpload(TARGET, FILE, "reason")).resolves.toEqual({ newUploadId: "u2" });
    expect(supa.rpc).toHaveBeenNthCalledWith(1, "reserve_trial_balance_source", { p_company_id: "co-1", p_file_name: "replacement.csv" });
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-source-signer", { body: { reservation_id: "res-1" } });
    expect(supa.uploadToSignedUrl).toHaveBeenCalledWith("workspaces/co-1/src-9/replacement.csv", "tok", FILE);
    expect(supa.rpc).toHaveBeenNthCalledWith(2, "retire_trial_balance_upload", { p_old_upload_id: "u1", p_expected_version: 1, p_reservation_id: "res-1", p_new_file_size: FILE.size, p_reason: "reason" });
    expect(supa.upload).not.toHaveBeenCalled();
  });

  it("no authority to reserve → forbidden, nothing uploaded", async () => {
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "forbidden", reservation_id: null, object_path: null }));
    const { retireUpload } = await import("./DiscardUploadDialog");
    await expect(retireUpload(TARGET, FILE)).rejects.toMatchObject({ code: "forbidden", retryable: false });
    expect(supa.invoke).not.toHaveBeenCalled();
    expect(supa.uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("the signed upload failing changes nothing (retryable)", async () => {
    supa.rpc.mockResolvedValueOnce(reserveOk());
    supa.invoke.mockResolvedValueOnce(signOk());
    supa.uploadToSignedUrl.mockResolvedValueOnce({ data: null, error: { message: "network" } });
    const { retireUpload } = await import("./DiscardUploadDialog");
    await expect(retireUpload(TARGET, FILE)).rejects.toMatchObject({ retryable: true });
    expect(supa.rpc).toHaveBeenCalledTimes(1);
  });

  it("stale_version / forbidden / already_discarded from retire keep their meaning", async () => {
    const { retireUpload } = await import("./DiscardUploadDialog");
    for (const [outcome, match] of [["stale_version", { code: "stale_version", retryable: true }], ["forbidden", { code: "forbidden", retryable: false }], ["already_discarded", { retryable: false }]] as const) {
      supa.rpc.mockResolvedValueOnce(reserveOk()).mockResolvedValueOnce(rows({ outcome, new_upload_id: null, retired_upload_id: null, detail: null }));
      supa.invoke.mockResolvedValueOnce(signOk());
      supa.uploadToSignedUrl.mockResolvedValueOnce({ data: {}, error: null });
      await expect(retireUpload(TARGET, FILE)).rejects.toMatchObject(match);
    }
  });
});

describe("isCertifiedRun — prefers lifecycle_state when present", () => {
  it("lifecycle_state drives the decision; status/is_valid is the pre-lifecycle fallback", async () => {
    const { isCertifiedRun } = await import("./DiscardUploadDialog");
    expect(isCertifiedRun({ id: "1", file_name: "x", lifecycle_state: "active_unprocessed", status: "complete", is_valid: true })).toBe(false);
    expect(isCertifiedRun({ id: "1", file_name: "x", lifecycle_state: "blocked" })).toBe(true);
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "complete", is_valid: null })).toBe(true);
    expect(isCertifiedRun(null)).toBe(false);
  });
});

describe("restoreUpload — Undo restores the retained source; nothing is re-uploaded or claimed", () => {
  const receipt = { id: "u1", fileName: "tb.xlsx", operationId: "op1", row: { id: "u1" }, filePath: TARGET.file_path };
  const restoreRow = (outcome: string) => rows({ outcome, upload_id: outcome === "restored" ? "u1" : null, detail: null });

  it("restored: one RPC, no Storage traffic", async () => {
    supa.rpc.mockResolvedValueOnce(restoreRow("restored"));
    const { restoreUpload } = await import("./DiscardUploadDialog");
    await expect(restoreUpload(receipt)).resolves.toEqual({ outcome: "restored", message: null });
    expect(supa.rpc).toHaveBeenCalledWith("restore_trial_balance_upload", { p_operation_id: "op1" });
    expect(supa.upload).not.toHaveBeenCalled();
    expect(supa.remove).not.toHaveBeenCalled();
  });

  it("EXACT SCENARIO: a new active upload → conflict_new_active_upload, never success", async () => {
    supa.rpc.mockResolvedValueOnce(restoreRow("conflict_new_active_upload"));
    const { restoreUpload } = await import("./DiscardUploadDialog");
    const r = await restoreUpload(receipt);
    expect(r.outcome).toBe("conflict_new_active_upload");
    expect(r.message).toMatch(/new trial balance is now active/i);
  });

  it("a Postgres unique-violation is NEVER read as 'already restored'", async () => {
    supa.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "duplicate key" } });
    const { restoreUpload } = await import("./DiscardUploadDialog");
    expect((await restoreUpload(receipt)).outcome).toBe("terminal_failure");
  });

  it("expired / forbidden / storage_restore_required / no operation all refuse with plain messages", async () => {
    const { restoreUpload, restoreOutcomeMessage } = await import("./DiscardUploadDialog");
    for (const o of ["expired", "forbidden", "storage_restore_required"]) {
      supa.rpc.mockResolvedValueOnce(restoreRow(o));
      expect((await restoreUpload(receipt)).outcome).toBe(o);
    }
    expect((await restoreUpload({ ...receipt, operationId: null })).outcome).toBe("stale_operation");
    for (const o of ["conflict_new_active_upload", "expired", "forbidden", "storage_restore_required", "stale_operation", "terminal_failure"] as const) {
      expect(restoreOutcomeMessage(o).length).toBeGreaterThan(10);
    }
  });
});

describe("offerUndo — the Undo button is actually rendered", () => {
  it("the toast title is TEXT: sonner omits action/cancel buttons for a React-element title (found by the staging browser suite)", async () => {
    const toastMod = await import("sonner");
    const success = vi.spyOn(toastMod.toast, "success").mockImplementation(() => "t1");
    const { offerUndo } = await import("./DiscardUploadDialog");
    offerUndo({ id: "u1", fileName: "tb.xlsx", operationId: "op1", row: {}, filePath: TARGET.file_path });
    const [title, opts] = success.mock.calls[0] as [unknown, { description?: unknown; action?: { label: string }; cancel?: { label: string }; classNames?: Record<string, string> }];
    expect(typeof title).toBe("string");
    expect(title).toBe("Discarded tb.xlsx");
    expect(opts.description).toBeTruthy();
    expect(opts.action?.label).toBe("Undo");
    expect(opts.cancel?.label).toBe("Dismiss");
    // The buttons stay on screen: content can shrink, a long file name wraps, the buttons never shrink.
    expect(opts.classNames).toMatchObject({ content: expect.stringContaining("min-w-0"), title: "break-all", actionButton: "shrink-0", cancelButton: "shrink-0" });
    success.mockRestore();
  });
});

describe("offerUndo — a success toast only for restored / already_restored", () => {
  it("conflict: shows the conflict as an error and never a 'restored' success", async () => {
    const toastMod = await import("sonner");
    const success = vi.spyOn(toastMod.toast, "success").mockImplementation(() => "t1");
    const error = vi.spyOn(toastMod.toast, "error").mockImplementation(() => "t2");
    const dismiss = vi.spyOn(toastMod.toast, "dismiss").mockImplementation(() => "t1");
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "conflict_new_active_upload", upload_id: null, detail: null }));
    const { offerUndo } = await import("./DiscardUploadDialog");
    const onRestored = vi.fn();
    offerUndo({ id: "u1", fileName: "tb.xlsx", operationId: "op1", row: {}, filePath: TARGET.file_path }, onRestored);
    (success.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(String(error.mock.calls[0][0])).toMatch(/new trial balance is now active/i);
    expect(success).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();
    success.mockRestore(); error.mockRestore(); dismiss.mockRestore();
  });
});

describe("cancelReplacement and the purge sweep — server-authoritative cleanup", () => {
  const REPLACEMENT = { ...TARGET, id: "rep1", replaces_upload_id: "u0", lifecycle_state: "active_unprocessed" };
  const cancelRow = (outcome: string, extra: Record<string, unknown> = {}) => rows({ outcome, operation_id: null, restored_upload_id: null, file_path: null, detail: null, ...extra });

  it("cancelled: the Edge Function removes the replacement's source (operation id only)", async () => {
    supa.rpc.mockResolvedValueOnce(cancelRow("cancelled", { operation_id: "c1", restored_upload_id: "u0" }));
    supa.invoke.mockResolvedValueOnce(cleanupOk("completed"));
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    await expect(cancelReplacement(REPLACEMENT)).resolves.toEqual({ restoredUploadId: "u0", storageCleanupPending: false });
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-storage-cleanup", { body: { operation_id: "c1" } });
  });

  it("a failed cleanup is reported as pending; processed replacement, forbidden and stale stay distinct", async () => {
    const { cancelReplacement } = await import("./DiscardUploadDialog");
    supa.rpc.mockResolvedValueOnce(cancelRow("cancelled", { operation_id: "c1", restored_upload_id: "u0" }));
    supa.invoke.mockResolvedValueOnce(cleanupHttpError("storage_cleanup_pending"));
    await expect(cancelReplacement(REPLACEMENT)).resolves.toEqual({ restoredUploadId: "u0", storageCleanupPending: true });
    supa.rpc.mockResolvedValueOnce(cancelRow("replacement_processed"));
    await expect(cancelReplacement(REPLACEMENT)).rejects.toMatchObject({ code: "replacement_required" });
    supa.rpc.mockResolvedValueOnce(cancelRow("forbidden"));
    await expect(cancelReplacement(REPLACEMENT)).rejects.toMatchObject({ code: "forbidden" });
    supa.rpc.mockResolvedValueOnce(cancelRow("stale_version"));
    await expect(cancelReplacement(REPLACEMENT)).rejects.toMatchObject({ code: "stale_version", retryable: true });
  });

  it("the browser never sweeps: purging is the scheduled server sweeper's job (trial-balance-source-sweeper)", async () => {
    const mod = await import("./DiscardUploadDialog");
    expect("sweepPurgeableSources" in mod).toBe(false);
    expect(supa.rpc).not.toHaveBeenCalledWith("list_purgeable_trial_balance_sources", expect.anything());
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

  it("defines the full lifecycle vocabulary and a purged operation state", () => {
    for (const state of ["active_unprocessed", "active_processing", "active_processed", "blocked", "retired", "superseded", "discard_pending", "discarded"]) {
      expect(sql).toContain(`'${state}'`);
    }
    expect(sql).toMatch(/'purged'/);
  });

  it("never touches the append-only certification guard or the CASCADE FK", () => {
    expect(sql).not.toMatch(/DISABLE TRIGGER/);
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]*?fk_tbc_upload/);
  });

  it("USER-BASED authority: ownership or an explicit grant; never firm_members or a title", () => {
    const pred = fn("workspace_authority_basis");
    expect(pred).toMatch(/c\.user_id = p_user_id/);
    expect(pred).toMatch(/revoked_at IS NULL/);
    expect(pred).not.toMatch(/firm_members|partner|manager|preparer|'owner'/);
    expect(sql).not.toMatch(/fm\.role IN/);
  });

  it("every source-file RPC authorizes through tbu_authorize (manage_source_files)", () => {
    for (const name of ["reserve_trial_balance_source", "register_trial_balance_upload", "discard_trial_balance_upload", "complete_trial_balance_discard",
      "restore_trial_balance_upload", "retire_trial_balance_upload", "cancel_trial_balance_replacement", "confirm_trial_balance_storage_cleanup", "purge_trial_balance_discard"]) {
      expect(fn(name), name).toMatch(/tbu_authorize\(/);
    }
  });

  it("workspace-scoped sources: the server derives the path; no RPC takes a client path", () => {
    expect(fn("reserve_trial_balance_source")).toMatch(/'workspaces\/' \|\| p_company_id::text/);
    expect(sql).not.toMatch(/p_new_file_path|p_storage_removed|p_storage_restored/);
    expect(sql).toMatch(/chk_tbsr_path_shape CHECK \(object_path LIKE 'workspaces\/' \|\| company_id::text \|\| '\/%'\)/);
  });

  it("discard completion no longer requires Storage removal; purge requires a terminal discard and a server-seen absence", () => {
    expect(fn("complete_trial_balance_discard")).not.toMatch(/tbu_storage_object_exists/);
    const purge = fn("purge_trial_balance_discard");
    expect(purge).toMatch(/tbu_undo_window\(\)/);
    expect(purge).toMatch(/tbu_storage_object_exists/);
    expect(fn("restore_trial_balance_upload")).toMatch(/tbu_storage_object_exists/);
  });

  it("path binding accepts the upload's own workspace path or its legacy uploader folder only", () => {
    const b = fn("tbu_bound_storage_path");
    expect(b).toMatch(/split_part\(p_upload\.file_path, '\/', 2\) = p_upload\.company_id::text/);
    expect(b).toMatch(/split_part\(p_upload\.file_path, '\/', 1\) = p_upload\.user_id::text/);
    expect(b).toMatch(/t\.id <> p_upload\.id/);
  });

  it("grants: client RPCs to authenticated only; the predicate and storage/reservation helpers to service_role only", () => {
    for (const f of ["discard_trial_balance_upload(uuid, bigint)", "complete_trial_balance_discard(uuid)", "restore_trial_balance_upload(uuid)",
      "retire_trial_balance_upload(uuid, bigint, uuid, integer, text)", "cancel_trial_balance_replacement(uuid, bigint)", "confirm_trial_balance_storage_cleanup(uuid)",
      "grant_workspace_capability(uuid, uuid, text)", "revoke_workspace_capability(uuid, uuid, text)", "reserve_trial_balance_source(uuid, text)",
      "register_trial_balance_upload(uuid, integer, integer, uuid, uuid)", "list_purgeable_trial_balance_sources(uuid)", "purge_trial_balance_discard(uuid)"]) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO authenticated`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon`);
    }
    for (const f of ["can_user_act_on_workspace(uuid, uuid, text)", "tbu_storage_object_exists(text)", "tbu_storage_cleanup_target(uuid)", "tbu_source_reservation_target(uuid)"]) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated`);
    }
  });
});
