/**
 * trialBalanceManagement — what "Manage Trial Balance" may show, and the client path to the server's removal
 * authority. The database decision itself (remove_trial_balance_upload / get_trial_balance_removal_eligibility:
 * retire never delete, plan + source authority, issued-output refusal, no client bypass, concurrency) is proven on
 * real PostgreSQL in scripts/db-proof/planCapabilities.mjs (group R-1); replacement atomicity (exactly one active
 * upload; a failed or foreign reservation replaces nothing) in scripts/db-proof/uploadLifecycle.mjs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";
import type { WorkspaceAccess } from "./workspaceAccess";

const rpc = vi.fn();
const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a), functions: { invoke: vi.fn() } } }));
const uploadWorkspaceSource = vi.fn();
vi.mock("@/lib/workspace/sourceUpload", async (orig) => ({ ...(await orig<typeof import("./sourceUpload")>()), uploadWorkspaceSource: (...a: unknown[]) => uploadWorkspaceSource(...a) }));

const {
  ISSUED_OUTPUT_EXPLANATION, buildManageTrialBalanceRoute, decideRemoveAction, decideSourceManagementMode, fetchRemovalEligibility,
  parseRemovalEligibility, removeTrialBalance, validateReplacementFile, RemoveTrialBalanceError,
} = await import("./trialBalanceManagement");
const { retireUpload, DiscardError } = await import("@/components/workspace/DiscardUploadDialog");

const access = (kind: WorkspaceAccess["kind"], capabilities: string[] = []): WorkspaceAccess => ({
  kind, capabilities, stages: kind === "capability" ? ["prepare"] : ["prepare", "reconcile"],
  company: { id: "c1", name: "Arusha Dc", fiscal_year_end: null, reporting_framework: null, currency: null, created_at: null },
});
const caps = (hasCurrentPlan: boolean | null, ok = true): MyWorkspaceCapabilities => ({ access: ok, held: [], allowed: [], hasCurrentPlan, manageBilling: false });
const known = (outcome: string, binding: string | null = null) => parseRemovalEligibility({ outcome, binding, version: 3 });

beforeEach(() => { rpc.mockReset(); from.mockReset(); uploadWorkspaceSource.mockReset(); });

describe("who sees mutation controls", () => {
  it("an active plan with source authority (owner, or an explicit manage_source_files grant) manages", () => {
    expect(decideSourceManagementMode(access("owner"), caps(true))).toBe("manage");
    expect(decideSourceManagementMode(access("capability", ["manage_source_files"]), caps(true))).toBe("manage");
  });
  it("an active plan without source authority is view-only (a member or a prepare-only grant)", () => {
    expect(decideSourceManagementMode(access("member"), caps(true))).toBe("view_only");
    expect(decideSourceManagementMode(access("capability", ["prepare_trial_balance"]), caps(true))).toBe("view_only");
  });
  it("no current plan is archive-only, even for the owner", () => {
    expect(decideSourceManagementMode(access("owner"), caps(false))).toBe("archive");
    expect(decideSourceManagementMode(access("capability", ["manage_source_files"]), caps(false))).toBe("archive");
  });
  it("anything unknown never widens: no access row, no capability read, no workspace access, unknown plan", () => {
    expect(decideSourceManagementMode(null, caps(true))).toBe("unknown");
    expect(decideSourceManagementMode(access("owner"), null)).toBe("unknown");
    expect(decideSourceManagementMode(access("owner"), caps(true, false))).toBe("unknown");
    expect(decideSourceManagementMode(access("owner"), caps(null))).toBe("unknown");
  });
});

describe("the Remove control follows the server's eligibility answer", () => {
  const blocked = { lifecycle_state: "blocked", status: "blocked", is_valid: false };
  const failed = { lifecycle_state: "active_processing", status: "error", is_valid: false };
  it("a Blocked paid upload and a failed upload offer Remove (retire), not hidden by their status", () => {
    expect(decideRemoveAction(blocked, known("remove"))).toEqual({ kind: "remove" });
    expect(decideRemoveAction(failed, known("remove"))).toEqual({ kind: "remove" });
    expect(decideRemoveAction({ lifecycle_state: "active_processing", status: "validating" }, known("remove"))).toEqual({ kind: "remove" });
  });
  it("issued output: Remove is shown disabled with the precise preservation reason", () => {
    expect(decideRemoveAction(blocked, known("issued_output_bound", "reporting_pack_issued")))
      .toEqual({ kind: "unavailable", reason: ISSUED_OUTPUT_EXPLANATION.reporting_pack_issued });
    expect(decideRemoveAction(blocked, known("issued_output_bound", "final_statements_published")))
      .toEqual({ kind: "unavailable", reason: ISSUED_OUTPUT_EXPLANATION.final_statements_published });
    expect(ISSUED_OUTPUT_EXPLANATION.reporting_pack_issued).toMatch(/stays in use and preserved/);
  });
  it("unprocessed uploads keep their reversible paths (discard with Undo; cancel a replacement)", () => {
    expect(decideRemoveAction({ lifecycle_state: "active_unprocessed" }, known("discard"))).toEqual({ kind: "discard" });
    expect(decideRemoveAction({ lifecycle_state: "active_unprocessed", replaces_upload_id: "u0" }, known("cancel_replacement"))).toEqual({ kind: "cancel_replacement" });
  });
  it("forbidden or no longer active: no Remove control", () => {
    expect(decideRemoveAction(blocked, known("forbidden"))).toBeNull();
    expect(decideRemoveAction(blocked, known("not_active"))).toBeNull();
    expect(decideRemoveAction(null, known("remove"))).toBeNull();
  });
  it("eligibility unavailable (for example, before the migration is applied): never a guess about a processed upload", () => {
    const unavailable = parseRemovalEligibility(null);
    expect(unavailable).toEqual({ status: "unavailable" });
    expect(decideRemoveAction(blocked, unavailable)).toBeNull();
    expect(decideRemoveAction(blocked, null)).toBeNull();
    expect(decideRemoveAction({ lifecycle_state: "active_unprocessed" }, unavailable)).toEqual({ kind: "discard" });
    expect(decideRemoveAction({ lifecycle_state: "active_unprocessed", replaces_upload_id: "u0" }, null)).toEqual({ kind: "cancel_replacement" });
  });
  it("a malformed eligibility answer is unavailable, never a guessed outcome", () => {
    expect(parseRemovalEligibility({ outcome: "delete" })).toEqual({ status: "unavailable" });
    expect(parseRemovalEligibility("remove")).toEqual({ status: "unavailable" });
    expect(parseRemovalEligibility({ outcome: "issued_output_bound", binding: "invented" })).toEqual({ status: "known", outcome: "issued_output_bound", binding: null });
  });
});

describe("the removal transport", () => {
  it("Remove calls remove_trial_balance_upload with the version seen — never a table DELETE", async () => {
    rpc.mockResolvedValueOnce({ data: [{ outcome: "removed", removed_upload_id: "u1", detail: null }], error: null });
    await removeTrialBalance({ id: "u1", version: 4 });
    expect(rpc).toHaveBeenCalledWith("remove_trial_balance_upload", { p_upload_id: "u1", p_expected_version: 4, p_reason: "Removed from active use via Prepare Data" });
    expect(from).not.toHaveBeenCalled();
  });
  it("already_removed succeeds; every refusal throws the server's plain-language reason; a transport failure says nothing changed", async () => {
    rpc.mockResolvedValueOnce({ data: [{ outcome: "already_removed", removed_upload_id: "u1", detail: null }], error: null });
    await expect(removeTrialBalance({ id: "u1", version: 4 })).resolves.toBeUndefined();
    rpc.mockResolvedValueOnce({ data: [{ outcome: "issued_output_bound", removed_upload_id: null, detail: "A Reporting Pack has been issued for this period…" }], error: null });
    await expect(removeTrialBalance({ id: "u1", version: 4 })).rejects.toMatchObject({ outcome: "issued_output_bound", message: "A Reporting Pack has been issued for this period…" });
    rpc.mockResolvedValueOnce({ data: [{ outcome: "stale_version", removed_upload_id: null, detail: null }], error: null });
    await expect(removeTrialBalance({ id: "u1", version: 4 })).rejects.toBeInstanceOf(RemoveTrialBalanceError);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "network" } });
    await expect(removeTrialBalance({ id: "u1", version: 4 })).rejects.toThrow(/Nothing was changed/);
  });
  it("the eligibility read: a failed or missing RPC is unavailable", async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: "remove", version: 2 }, error: null });
    expect(await fetchRemovalEligibility("u1")).toEqual({ status: "known", outcome: "remove", binding: null });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Could not find the function", code: "PGRST202" } });
    expect(await fetchRemovalEligibility("u1")).toEqual({ status: "unavailable" });
  });
});

describe("Replace keeps the current Trial Balance unless the swap succeeds", () => {
  it("an invalid file is refused before anything is uploaded or changed", () => {
    expect(validateReplacementFile({ name: "TB.xlsx", size: 1200 })).toBeNull();
    expect(validateReplacementFile({ name: "tb.CSV", size: 10 })).toBeNull();
    expect(validateReplacementFile({ name: "TB.pdf", size: 1200 })).toMatch(/CSV or Excel/);
    expect(validateReplacementFile({ name: "TB.xlsx", size: 0 })).toMatch(/empty/);
    expect(validateReplacementFile(null)).toMatch(/No file/);
  });
  it("a failed upload of the new file never calls the swap: the current binding is untouched", async () => {
    uploadWorkspaceSource.mockRejectedValueOnce(new Error("storage down"));
    await expect(retireUpload({ id: "u1", file_name: "TB.xlsx", company_id: "c1", version: 3 }, new File(["x"], "new.xlsx"))).rejects.toBeInstanceOf(DiscardError);
    expect(rpc).not.toHaveBeenCalledWith("retire_trial_balance_upload", expect.anything());
  });
  it("a refused swap (stale version) reports it and creates nothing", async () => {
    uploadWorkspaceSource.mockResolvedValueOnce({ reservationId: "r1", objectPath: "c1/x.xlsx" });
    rpc.mockResolvedValueOnce({ data: [{ outcome: "stale_version", new_upload_id: null, retired_upload_id: null, detail: null }], error: null });
    await expect(retireUpload({ id: "u1", file_name: "TB.xlsx", company_id: "c1", version: 3 }, new File(["x"], "new.xlsx"))).rejects.toMatchObject({ code: "stale_version" });
  });
});

describe("the Overview's Manage file destination", () => {
  it("opens Prepare Data on the exact upload and focuses the management area", () => {
    expect(buildManageTrialBalanceRoute("c1", 2025, "u1")).toBe("/workspace/c1/2025/prepare?upload=u1&manage=source#manage-trial-balance");
    expect(buildManageTrialBalanceRoute("c1", 2025, null)).toBe("/workspace/c1/2025/prepare?manage=source#manage-trial-balance");
  });
});
