/**
 * trialBalanceManagement — what the "Manage Trial Balance" area may offer, and the client path to the server's
 * removal authority (20260927100000_trial_balance_remove_from_active_use.sql).
 *
 * The database decides every mutation. This module only chooses what to SHOW, from two server reads:
 *   get_workspace_access          → owner, or an explicit manage_source_files grant (the PR #32 source authority);
 *   get_my_workspace_capabilities → whether the workspace's account has a current plan;
 * and, per upload, get_trial_balance_removal_eligibility → which removal path the server accepts.
 * Unknown or malformed input never widens anything: no mutation control is shown until both reads agree.
 *
 * "Remove" never hard-deletes accounting evidence:
 *   remove              a processed, blocked or failed upload is RETIRED (terminal; the row, hashes, certifications and
 *                       results are kept; lifecycle audit event). No Undo: a retired upload cannot become active again.
 *   discard             an unprocessed upload with no history uses the PR #32 discard saga (row snapshot and audit
 *                       event kept; Undo within the window).
 *   cancel_replacement  an unprocessed replacement is cancelled, restoring the upload it replaced.
 */

import { supabase } from "@/integrations/supabase/client";
import type { MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";
import type { WorkspaceAccess } from "./workspaceAccess";

/** The DOM id of the management area; the Overview's "Manage file" link lands on it. */
export const MANAGE_TRIAL_BALANCE_ANCHOR = "manage-trial-balance";
/** Query flag that asks Prepare Data to focus the management area. */
export const MANAGE_TRIAL_BALANCE_PARAM = "manage";

export type SourceManagementMode =
  /** A current plan and source-file authority: Replace and (when the server allows) Remove. */
  | "manage"
  /** A current plan, but no source-file authority: no mutation control. */
  | "view_only"
  /** No current plan: historical, read-only. */
  | "archive"
  /** Not yet known (loading, a failed read): no mutation control. */
  | "unknown";

export function decideSourceManagementMode(
  access: WorkspaceAccess | null | undefined,
  capabilities: MyWorkspaceCapabilities | null | undefined,
): SourceManagementMode {
  if (!access || !capabilities || !capabilities.access) return "unknown";
  if (capabilities.hasCurrentPlan === false) return "archive";
  if (capabilities.hasCurrentPlan !== true) return "unknown";
  return access.kind === "owner" || access.capabilities.includes("manage_source_files") ? "manage" : "view_only";
}

export type RemovalEligibilityOutcome = "remove" | "discard" | "cancel_replacement" | "issued_output_bound" | "not_active" | "forbidden";
export type IssuedOutputBinding = "reporting_pack_issued" | "final_statements_published";

export type RemovalEligibility =
  | { status: "known"; outcome: RemovalEligibilityOutcome; binding: IssuedOutputBinding | null }
  /** The eligibility read is not available (for example, before the migration is applied) or failed. */
  | { status: "unavailable" };

const OUTCOMES: readonly RemovalEligibilityOutcome[] = ["remove", "discard", "cancel_replacement", "issued_output_bound", "not_active", "forbidden"];
const BINDINGS: readonly IssuedOutputBinding[] = ["reporting_pack_issued", "final_statements_published"];

/** Strict parse; malformed → unavailable (never a guessed outcome). */
export function parseRemovalEligibility(raw: unknown): RemovalEligibility {
  if (!raw || typeof raw !== "object") return { status: "unavailable" };
  const r = raw as Record<string, unknown>;
  if (!OUTCOMES.includes(r.outcome as RemovalEligibilityOutcome)) return { status: "unavailable" };
  const binding = BINDINGS.includes(r.binding as IssuedOutputBinding) ? (r.binding as IssuedOutputBinding) : null;
  return { status: "known", outcome: r.outcome as RemovalEligibilityOutcome, binding };
}

export interface RemovableUpload {
  lifecycle_state?: string | null;
  status?: string | null;
  is_valid?: boolean | null;
  replaces_upload_id?: string | null;
}

export type RemoveAction =
  | { kind: "remove" | "discard" | "cancel_replacement" }
  /** Shown, but disabled, with the exact reason. */
  | { kind: "unavailable"; reason: string };

export const ISSUED_OUTPUT_EXPLANATION: Readonly<Record<IssuedOutputBinding, string>> = {
  reporting_pack_issued:
    "A Reporting Pack has been issued for this period, so this Trial Balance stays in use and preserved. Replace it if the figures must change.",
  final_statements_published:
    "Final financial statements have been published for this period, so this Trial Balance stays in use and preserved. Replace it if the figures must change.",
};

/**
 * The Remove control for an upload in "manage" mode. The server's eligibility answer decides; while it is unavailable
 * only the pre-existing, unprocessed paths are offered (the lifecycle state alone proves those), never a guess about
 * a processed upload. null = no Remove control at all.
 */
export function decideRemoveAction(upload: RemovableUpload | null | undefined, eligibility: RemovalEligibility | null): RemoveAction | null {
  if (!upload) return null;
  if (eligibility?.status === "known") {
    switch (eligibility.outcome) {
      case "remove":
      case "discard":
      case "cancel_replacement":
        return { kind: eligibility.outcome };
      case "issued_output_bound":
        return { kind: "unavailable", reason: ISSUED_OUTPUT_EXPLANATION[eligibility.binding ?? "reporting_pack_issued"] };
      default:
        return null;
    }
  }
  const unprocessed = upload.lifecycle_state
    ? upload.lifecycle_state === "active_unprocessed"
    : upload.status !== "complete" && upload.is_valid !== true;
  if (!unprocessed) return null;
  return { kind: upload.replaces_upload_id ? "cancel_replacement" : "discard" };
}

type RpcError = { message: string; code?: string } | null;
interface RemoveRpcRow { outcome: string; removed_upload_id: string | null; detail: string | null }
interface RemovalRpcClient {
  rpc(name: "get_trial_balance_removal_eligibility", args: { p_upload_id: string }): PromiseLike<{ data: unknown; error: RpcError }>;
  rpc(name: "remove_trial_balance_upload", args: { p_upload_id: string; p_expected_version: number; p_reason?: string }):
    PromiseLike<{ data: RemoveRpcRow[] | null; error: RpcError }>;
}
// The migration is committed but not yet in the generated types; the cast is scoped to exactly these two RPCs.
const removalRpc = () => supabase as unknown as RemovalRpcClient;

export async function fetchRemovalEligibility(uploadId: string): Promise<RemovalEligibility> {
  const { data, error } = await removalRpc().rpc("get_trial_balance_removal_eligibility", { p_upload_id: uploadId });
  if (error) return { status: "unavailable" };
  return parseRemovalEligibility(data);
}

export class RemoveTrialBalanceError extends Error {
  readonly outcome: string;
  constructor(message: string, outcome: string) {
    super(message);
    this.name = "RemoveTrialBalanceError";
    this.outcome = outcome;
  }
}

/**
 * Takes a processed upload out of active use (retire; nothing deleted). 'removed' and 'already_removed' succeed;
 * every other outcome throws with the server's plain-language reason.
 */
export async function removeTrialBalance(upload: { id: string; version?: number | null }): Promise<void> {
  const { data, error } = await removalRpc().rpc("remove_trial_balance_upload", {
    p_upload_id: upload.id,
    p_expected_version: upload.version ?? 1,
    p_reason: "Removed from active use via Prepare Data",
  });
  if (error) throw new RemoveTrialBalanceError("Could not remove this Trial Balance. Nothing was changed. Please try again.", "transport_error");
  const row = data?.[0];
  if (row?.outcome === "removed" || row?.outcome === "already_removed") return;
  throw new RemoveTrialBalanceError(row?.detail ?? "Could not remove this Trial Balance. Nothing was changed.", row?.outcome ?? "unknown");
}

/** Prepare Data with the management area focused (the Overview's "Manage file" destination). */
export function buildManageTrialBalanceRoute(companyId: string, periodYear: number, uploadId?: string | null): string {
  const base = `/workspace/${companyId}/${periodYear}/prepare`;
  const params = new URLSearchParams();
  if (uploadId) params.set("upload", uploadId);
  params.set(MANAGE_TRIAL_BALANCE_PARAM, "source");
  return `${base}?${params.toString()}#${MANAGE_TRIAL_BALANCE_ANCHOR}`;
}

/** The same file types the uploader accepts (TrialBalanceUpload). */
export const TRIAL_BALANCE_FILE_TYPES = [".csv", ".xlsx", ".xls"] as const;

/** Checks a picked replacement BEFORE anything is uploaded or changed. null = acceptable. */
export function validateReplacementFile(file: { name: string; size: number } | null | undefined): string | null {
  if (!file) return "No file was selected.";
  const lower = file.name.toLowerCase();
  if (!TRIAL_BALANCE_FILE_TYPES.some((ext) => lower.endsWith(ext))) return "Choose a CSV or Excel (.xlsx, .xls) Trial Balance file.";
  if (!Number.isFinite(file.size) || file.size <= 0) return "The selected file is empty.";
  return null;
}
