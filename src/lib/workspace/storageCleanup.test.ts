/**
 * storageCleanup.test.ts: the decision sequence of the trial-balance-storage-cleanup Edge Function
 * (supabase/functions/_shared/storageCleanup.ts), with every dependency injected. The same module runs in the
 * function. The hosted staging proof (scripts/upload_lifecycle_staging.mjs) exercises it end to end.
 */
import { describe, expect, it, vi } from "vitest";
import { parseCleanupRequest, runStorageCleanup, type CleanupDeps, type CleanupTarget } from "../../../supabase/functions/_shared/storageCleanup";

const OP = "7a1e4d92-2f8b-4c3e-b056-f9a2d7e14b83";
const target = (over: Partial<CleanupTarget> = {}): CleanupTarget =>
  ({ kind: "discard", state: "completed", company_id: "co-1", file_path: "workspaces/co-1/src/tb.csv", deletion_eligible: true, ...over });

function deps(over: Partial<CleanupDeps> = {}) {
  const d = {
    authenticate: vi.fn(async () => "user-1"),
    resolveTarget: vi.fn(async () => target()),
    canManage: vi.fn(async () => true),
    removeObject: vi.fn(async () => ({ ok: true })),
    objectExists: vi.fn(async () => false),
    completeAsCaller: vi.fn(async () => ({ outcome: "deleted_now" })),
    ...over,
  };
  return d as typeof d & CleanupDeps;
}

describe("request parsing: only an opaque operation id is accepted", () => {
  it("accepts exactly { operation_id: uuid }", () => {
    expect(parseCleanupRequest({ operation_id: OP })).toEqual({ operationId: OP });
  });
  it("refuses path substitution, company/user/role/claim fields, malformed ids and non-objects", () => {
    for (const body of [
      { operation_id: OP, file_path: "victim/secret.csv" }, { operation_id: OP, company_id: "x" }, { operation_id: OP, user_id: "x" },
      { operation_id: OP, role: "owner" }, { operation_id: OP, storage_removed: true }, { operation_id: "not-a-uuid" },
      { operation_id: 42 }, {}, null, "x", [OP],
    ]) expect(parseCleanupRequest(body)).toBeNull();
  });
});

describe("runStorageCleanup", () => {
  it("terminal discard (undo window over): purges ONLY the server-resolved path, verifies absence, records the purge as the caller", async () => {
    const d = deps({ completeAsCaller: vi.fn(async () => ({ outcome: "purged" })) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 200, outcome: "completed" });
    expect(d.canManage).toHaveBeenCalledWith("user-1", "co-1");
    expect(d.removeObject).toHaveBeenCalledWith("workspaces/co-1/src/tb.csv");
    expect(d.completeAsCaller).toHaveBeenCalledWith("discard", OP);
  });

  it("a discard still inside its undo window is NOT deleted: the source stays restorable (409 undo_window_open)", async () => {
    const d = deps({ resolveTarget: vi.fn(async () => target({ deletion_eligible: false })), completeAsCaller: vi.fn(async () => ({ outcome: "undo_window_open" })) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 409, outcome: "undo_window_open" });
    expect(d.removeObject).not.toHaveBeenCalled();
  });

  it("a restored discard is never purged (409 not_purgeable)", async () => {
    const d = deps({ resolveTarget: vi.fn(async () => target({ state: "restored", deletion_eligible: false })), completeAsCaller: vi.fn(async () => ({ outcome: "not_purgeable" })) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 409, outcome: "not_purgeable" });
    expect(d.removeObject).not.toHaveBeenCalled();
  });

  it("unauthenticated: nothing is resolved or deleted", async () => {
    const d = deps({ authenticate: vi.fn(async () => null) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 401, outcome: "unauthenticated" });
    expect(d.resolveTarget).not.toHaveBeenCalled();
    expect(d.removeObject).not.toHaveBeenCalled();
  });

  it("forged / unknown operation id: stale_operation, nothing deleted", async () => {
    const d = deps({ resolveTarget: vi.fn(async () => null) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 404, outcome: "stale_operation" });
    expect(d.removeObject).not.toHaveBeenCalled();
  });

  it("unauthorized, revoked or cross-workspace caller: forbidden BEFORE any service-role deletion", async () => {
    const d = deps({ canManage: vi.fn(async () => false) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 403, outcome: "forbidden" });
    expect(d.removeObject).not.toHaveBeenCalled();
    expect(d.completeAsCaller).not.toHaveBeenCalled();
  });

  it("Storage failure: stays pending (recoverable), the database is not asked to complete", async () => {
    const d = deps({ removeObject: vi.fn(async () => ({ ok: false })) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 502, outcome: "storage_cleanup_pending" });
    expect(d.completeAsCaller).not.toHaveBeenCalled();
  });

  it("a remove that reports success but leaves the object: still pending, never completed", async () => {
    const d = deps({ objectExists: vi.fn(async () => true) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 502, outcome: "storage_cleanup_pending" });
    expect(d.completeAsCaller).not.toHaveBeenCalled();
  });

  it("database completion failure after deletion: completion_failed, operation stays pending for an idempotent retry", async () => {
    const d = deps({ completeAsCaller: vi.fn(async () => null) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 500, outcome: "completion_failed" });
  });

  it("missing object (already gone): removal is a no-op and the purge is recorded", async () => {
    const d = deps({ completeAsCaller: vi.fn(async () => ({ outcome: "purged" })) });
    await expect(runStorageCleanup(d, OP)).resolves.toMatchObject({ outcome: "completed" });
  });

  it("repeated purge: no deletion, the database's idempotent answer", async () => {
    const d = deps({ resolveTarget: vi.fn(async () => target({ state: "purged", deletion_eligible: false })), completeAsCaller: vi.fn(async () => ({ outcome: "already_purged" })) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 200, outcome: "already_completed" });
    expect(d.removeObject).not.toHaveBeenCalled();
  });

  it("an operation with no bound path (e.g. a forged row pointing at someone else's file) never deletes anything", async () => {
    const d = deps({ resolveTarget: vi.fn(async () => target({ file_path: null })), completeAsCaller: vi.fn(async () => ({ outcome: "purged" })) });
    await runStorageCleanup(d, OP);
    expect(d.removeObject).not.toHaveBeenCalled();
    expect(d.completeAsCaller).toHaveBeenCalled();
  });

  it("cancelled replacement: deletes at once and completes through confirm (kind cancel_replacement)", async () => {
    const d = deps({ resolveTarget: vi.fn(async () => target({ kind: "cancel_replacement", state: "storage_cleanup_pending" })), completeAsCaller: vi.fn(async () => ({ outcome: "completed" })) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 200, outcome: "completed" });
    expect(d.removeObject).toHaveBeenCalled();
    expect(d.completeAsCaller).toHaveBeenCalledWith("cancel_replacement", OP);
  });

  it("the database still refusing the caller (e.g. revoked between checks) is reported as forbidden", async () => {
    const d = deps({ completeAsCaller: vi.fn(async () => ({ outcome: "forbidden" })) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 403, outcome: "forbidden" });
  });

  it("an unexpected completion answer never becomes a success", async () => {
    const d = deps({ completeAsCaller: vi.fn(async () => ({ outcome: "something_new" })) });
    await expect(runStorageCleanup(d, OP)).resolves.toEqual({ status: 500, outcome: "completion_failed" });
  });
});
