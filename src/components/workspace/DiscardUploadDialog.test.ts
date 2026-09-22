/**
 * DiscardUploadDialog.test.ts — discardUpload()'s fail-closed behaviour.
 *
 * Post-merge hardening (fix/post-merge-workspace-release-blockers): discardUpload() no longer makes
 * its own existence/authorization decision from two separate client-side calls (a `.delete()` plus
 * a follow-up `.select()`) — that pattern is exactly what DSC-MUCTHLMV-44GK class failures trace
 * back to: RLS filters an unauthorized row out of visibility rather than raising a distinguishable
 * error, so a client-side "is it still there?" check cannot tell a genuine FORBIDDEN case apart
 * from ALREADY_DISCARDED. The authoritative decision now comes from a single call to the
 * discard_trial_balance_upload() SECURITY DEFINER RPC (20260922180000_discard_trial_balance_authority.sql),
 * which has full visibility and checks authorization explicitly inside its own body. These tests
 * mock that RPC boundary and assert discardUpload() maps every one of its four outcomes correctly —
 * including the FORBIDDEN case that the old client-side logic could misclassify as success.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const supa = vi.hoisted(() => ({
  rpc: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  insert: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string, args: unknown) => supa.rpc(name, args),
    from: (table: string) => ({
      insert: (row: unknown) => supa.insert(table, row),
    }),
    storage: { from: () => ({ download: (p: string) => supa.download(p), remove: (p: string[]) => supa.remove(p), upload: vi.fn(async () => ({ error: null })) }) },
  },
}));

afterEach(() => vi.clearAllMocks());

const TARGET = { id: "u1", file_name: "tb.xlsx", file_path: "co/tb.xlsx", status: "needs_review", is_valid: null };
const ROW_SNAPSHOT = { id: "u1", file_name: "tb.xlsx", status: "needs_review" };

function rpcRow(outcome: string, extra: Partial<{ row_snapshot: unknown; file_path: string | null; detail: string | null }> = {}) {
  return { data: [{ outcome, row_snapshot: null, file_path: null, detail: null, ...extra }], error: null };
}

describe("discardUpload — calls the authoritative RPC exactly once with the target id", () => {
  it("passes p_upload_id and never touches .delete()/.select() on the table directly", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc.mockResolvedValueOnce(rpcRow("deleted_now", { row_snapshot: ROW_SNAPSHOT, file_path: "co/tb.xlsx" }));
    const { discardUpload } = await import("./DiscardUploadDialog");

    await discardUpload(TARGET);
    expect(supa.rpc).toHaveBeenCalledTimes(1);
    expect(supa.rpc).toHaveBeenCalledWith("discard_trial_balance_upload", { p_upload_id: "u1" });
  });
});

describe("discardUpload — a transport-level RPC failure is retryable and never leaks raw error detail", () => {
  it("network/RPC error: DiscardError, retryable, no row deleted assumption either way", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.rpc.mockResolvedValueOnce({ data: null, error: { message: "connection reset", code: "08006" } });
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try {
      await discardUpload(TARGET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiscardError);
    const err = caught as InstanceType<typeof DiscardError>;
    expect(err.retryable).toBe(true);
    expect(err.reference).toMatch(/^DSC-/);
    expect(err.safeMessage).toContain(err.reference);
    expect(err.safeMessage).not.toContain("connection reset");
    expect(supa.remove).not.toHaveBeenCalled();
  });

  it("an empty result set from the RPC (defensive — should not happen) is also retryable, never a silent success", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.rpc.mockResolvedValueOnce({ data: [], error: null });
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    await expect(discardUpload(TARGET)).rejects.toBeInstanceOf(DiscardError);
  });
});

describe("discardUpload — the four authoritative outcomes are mapped correctly", () => {
  it("deleted_now: full receipt (row snapshot + file) returned, storage cleanup attempted with the RPC's own file_path", async () => {
    const blob = new Blob(["contents"]);
    supa.download.mockResolvedValueOnce({ data: blob });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc.mockResolvedValueOnce(rpcRow("deleted_now", { row_snapshot: ROW_SNAPSHOT, file_path: "co/tb.xlsx" }));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", row: ROW_SNAPSHOT, filePath: "co/tb.xlsx", fileBlob: blob });
    expect(supa.remove).toHaveBeenCalledWith(["co/tb.xlsx"]);
  });

  it("already_discarded — THE ROOT-CAUSE CASE: the row genuinely does not exist, checked with full visibility inside the RPC (never an artifact of this caller's own RLS-scoped SELECT). Idempotent success: no fabricated row snapshot, since this call never deleted anything", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.rpc.mockResolvedValueOnce(rpcRow("already_discarded", { detail: "This trial balance no longer exists." }));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload(TARGET);
    expect(receipt.row).toBeNull();
    expect(receipt.fileBlob).toBeNull();
    // Best-effort storage cleanup still attempted using the client's own last-known path.
    expect(supa.remove).toHaveBeenCalledWith(["co/tb.xlsx"]);
  });

  it("forbidden — a non-uploader firm member (or any caller with no accepted membership) is refused authoritatively, never misreported as already_discarded: FAILED_TERMINAL, not retryable", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.rpc.mockResolvedValueOnce(rpcRow("forbidden", { detail: "You are not authorised to discard this trial balance." }));
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try {
      await discardUpload(TARGET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiscardError);
    const err = caught as InstanceType<typeof DiscardError>;
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/not authorised/i);
    expect(err.safeMessage).not.toMatch(/safe to try again/i);
    // No storage mutation on a forbidden outcome — nothing was authorised to be removed.
    expect(supa.remove).not.toHaveBeenCalled();
  });

  it("dependency_conflict: FAILED_TERMINAL, not retryable, names no internal table/constraint", async () => {
    supa.download.mockResolvedValueOnce({ data: null });
    supa.rpc.mockResolvedValueOnce(rpcRow("dependency_conflict", { detail: "Other records in this workspace still depend on this trial balance." }));
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try {
      await discardUpload(TARGET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiscardError);
    const err = caught as InstanceType<typeof DiscardError>;
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/other records.*depend on/i);
    expect(err.safeMessage).not.toContain("hesabu_validations");
    expect(err.safeMessage).not.toContain("fk_");
  });
});

describe("discardUpload — the happy path with no stored file", () => {
  it("a target with no file_path skips storage download/remove entirely and still succeeds", async () => {
    supa.rpc.mockResolvedValueOnce(rpcRow("deleted_now", { row_snapshot: ROW_SNAPSHOT, file_path: null }));
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload({ ...TARGET, file_path: null });
    expect(supa.download).not.toHaveBeenCalled();
    expect(supa.remove).not.toHaveBeenCalled();
    expect(receipt.fileBlob).toBeNull();
  });
});

describe("restoreUpload — release blocker 2.2: idempotent against a redundant second Undo click", () => {
  const receipt = { id: "u1", fileName: "tb.xlsx", row: { id: "u1", file_name: "tb.xlsx" }, filePath: null, fileBlob: null };

  it("a unique-violation on insert (the row is already back) is treated as success, not surfaced as a restore failure", async () => {
    supa.insert.mockResolvedValueOnce({ error: { code: "23505", message: 'duplicate key value violates unique constraint "trial_balance_uploads_pkey"' } });
    const { restoreUpload } = await import("./DiscardUploadDialog");

    await expect(restoreUpload(receipt)).resolves.toBeUndefined();
  });

  it("any other insert failure still throws", async () => {
    supa.insert.mockResolvedValueOnce({ error: { code: "08006", message: "connection reset" } });
    const { restoreUpload } = await import("./DiscardUploadDialog");

    await expect(restoreUpload(receipt)).rejects.toBeTruthy();
  });

  it("no receipt.row: refuses to restore rather than inserting a fabricated row — the correct behaviour for an already_discarded receipt", async () => {
    const { restoreUpload } = await import("./DiscardUploadDialog");
    await expect(restoreUpload({ ...receipt, row: null })).rejects.toThrow(/can no longer be undone/i);
    expect(supa.insert).not.toHaveBeenCalled();
  });
});

describe("isCertifiedRun", () => {
  it("treats a complete or explicitly-valid run as certified evidence requiring the typed DISCARD gate", async () => {
    const { isCertifiedRun } = await import("./DiscardUploadDialog");
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "complete", is_valid: null })).toBe(true);
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "needs_review", is_valid: true })).toBe(true);
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "needs_review", is_valid: false })).toBe(false);
    expect(isCertifiedRun(null)).toBe(false);
    expect(isCertifiedRun(undefined)).toBe(false);
  });
});

/**
 * Structural proof against the migration itself — the closest thing to "reproducing" the original
 * DSC-MUCTHLMV-44GK root cause available without a live database (no docker/local Postgres in this
 * environment; the real dynamic proof is CI's "Disposable-DB Contract Tests" job, which applies
 * this exact migration to a throwaway postgres:16 container). This asserts the actual SQL contains
 * the two structural elements the root-cause analysis depends on: an ADDITIVE (not replacing)
 * accepted-firm-member DELETE policy, and a SECURITY DEFINER function that checks authorization
 * explicitly rather than delegating to RLS.
 */
describe("20260922180000_discard_trial_balance_authority.sql — structural proof of the fix", () => {
  const sql = readFileSync(
    join(__dirname, "../../../supabase/migrations/20260922180000_discard_trial_balance_authority.sql"),
    "utf8",
  );

  it("adds a DELETE policy scoped to accepted firm members, additive to (not replacing) the uploader-only policy", () => {
    expect(sql).toMatch(/CREATE POLICY[^;]*ON public\.trial_balance_uploads[\s\S]*?FOR DELETE/);
    expect(sql).not.toMatch(/DROP POLICY "Users can delete their own uploads"/);
    expect(sql).toMatch(/accepted_at IS NOT NULL/);
  });

  it("the RPC is SECURITY DEFINER and checks authorization explicitly against firm_members, never relying on RLS to filter", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.discard_trial_balance_upload/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/v_authorized/);
    expect(sql).toMatch(/IF NOT v_authorized THEN/);
  });

  it("returns exactly the four documented outcomes and grants execution only to authenticated", () => {
    for (const outcome of ["deleted_now", "already_discarded", "forbidden", "dependency_conflict"]) {
      expect(sql).toContain(`'${outcome}'`);
    }
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.discard_trial_balance_upload\(uuid\) TO authenticated/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.discard_trial_balance_upload\(uuid\) FROM PUBLIC, anon/);
  });
});
