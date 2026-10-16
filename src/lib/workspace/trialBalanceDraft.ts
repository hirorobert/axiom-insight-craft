/**
 * trialBalanceDraft — the ONE browser path for a trial balance draft: a file stored privately before it belongs to an
 * entity (Phase 2 P2-2; 20261106100000 + the trial-balance-draft Edge Function).
 *
 *   1. reserve: reserve_trial_balance_draft(name, size, SHA-256 of the bytes, key). The same key with the same file
 *      returns the same draft; the same key with another file is refused. No entity is needed.
 *   2. upload: trial-balance-draft { sign } returns a single-object signed URL for exactly drafts/<you>/<draft>/<name>.
 *   3. commit: trial-balance-draft { commit } adds the draft to an entity and period with the context the user
 *      confirmed (entity, period, currency). The commit key is kept for this draft and target, so a retry after a lost
 *      response resumes the same commit instead of starting another; changed inputs under one key are refused.
 *
 * Rollout safety: when the backend does not have drafts yet (the migration or the function is not deployed), every step
 * throws DraftError("drafts_unavailable") with an actionable message — never a false success — and the existing
 * entity-first upload remains the way in.
 */

import { supabase } from "@/integrations/supabase/client";
import { TB_UPLOAD_POLICY } from "./uploadPolicy";

export type DraftErrorCode =
  | "drafts_unavailable" | "forbidden" | "invalid_file" | "conflict" | "expired" | "not_found" | "content_mismatch"
  | "active_upload_exists" | "replace_conflict" | "upload_failed" | "retry" | "failed";

export class DraftError extends Error {
  readonly code: DraftErrorCode;
  readonly retryable: boolean;
  /** The commit the refusal belongs to, when the server named one (so it can be cancelled before another target). */
  commitId?: string;
  constructor(message: string, code: DraftErrorCode, retryable: boolean) {
    super(message);
    this.name = "DraftError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const DRAFT_MESSAGES = {
  unavailable: "Uploading before choosing an entity isn't available yet. Add the entity first, then upload your trial balance.",
  forbidden: "You don't have permission to add a trial balance to this entity.",
  invalidFile: `This file can't be uploaded. Use a CSV or Excel file of at most ${Math.round(TB_UPLOAD_POLICY.maxFileBytes / 1_048_576)} MB.`,
  conflict: "This upload changed while it was being saved. Start the upload again.",
  expired: "This upload is no longer available. Upload the file again.",
  contentMismatch: "The stored file is not the file that was checked. Upload it again.",
  retry: "This didn't finish. Try again; nothing will be added twice.",
} as const;

/** The one upload policy's file-size limit (uploadPolicy.ts; equal to the drafts migration's CHECK). */
export const DRAFT_MAX_BYTES = TB_UPLOAD_POLICY.maxFileBytes;
// PostgREST "function not found" / Postgres undefined function or table: the migration is not applied yet.
const RPC_NOT_DEPLOYED = new Set(["PGRST202", "PGRST205", "42883", "42P01"]);

type RpcError = { message: string; code?: string } | null;
interface DraftRpcClient {
  rpc(name: "reserve_trial_balance_draft", args: { p_file_name: string; p_file_size: number; p_content_sha256: string; p_idempotency_key: string }):
    Promise<{ data: { outcome: string; draft_id: string | null; object_path: string | null; expires_at: string | null }[] | null; error: RpcError }>;
}
// The migration is committed but not yet applied to any live database, so the generated types do not know it.
const draftRpc = () => supabase as unknown as DraftRpcClient;

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random idempotency key in the server's accepted alphabet. */
export function newDraftKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface FunctionReply { status: number | null; body: Record<string, unknown> | null }

async function invokeDraft(body: Record<string, unknown>): Promise<FunctionReply> {
  const r = await supabase.functions.invoke("trial-balance-draft", { body });
  if (!r.error) return { status: 200, body: (r.data ?? null) as Record<string, unknown> | null };
  const ctx = (r.error as { context?: { status?: number; json?: () => Promise<unknown> } }).context;
  let parsed: Record<string, unknown> | null = null;
  try { parsed = ((await ctx?.json?.()) ?? null) as Record<string, unknown> | null; } catch { parsed = null; }
  return { status: typeof ctx?.status === "number" ? ctx.status : null, body: parsed };
}

/**
 * An answer that did not come from this function at all: the function is not deployed (the gateway's own 404) or the
 * request never reached it. Our function always answers with an `outcome`.
 */
function notDeployed(reply: FunctionReply): boolean {
  return reply.body?.outcome === "drafts_unavailable" || (reply.status === 404 && typeof reply.body?.outcome !== "string");
}

function refusal(outcome: unknown, detail?: unknown): DraftError {
  const d = typeof detail === "string" && detail ? detail : null;
  switch (outcome) {
    case "drafts_unavailable": return new DraftError(DRAFT_MESSAGES.unavailable, "drafts_unavailable", false);
    case "forbidden": case "unauthenticated": return new DraftError(DRAFT_MESSAGES.forbidden, "forbidden", false);
    case "commit_conflict": case "conflict": return new DraftError(DRAFT_MESSAGES.conflict, "conflict", false);
    case "expired": case "not_eligible": return new DraftError(DRAFT_MESSAGES.expired, "expired", false);
    case "not_found": return new DraftError(DRAFT_MESSAGES.expired, "not_found", false);
    case "content_mismatch": return new DraftError(DRAFT_MESSAGES.contentMismatch, "content_mismatch", false);
    case "active_upload_exists": return new DraftError(d ?? "A trial balance is already active for this period.", "active_upload_exists", false);
    case "replace_conflict": return new DraftError(d ?? "The current trial balance changed. Look at it again, then replace it.", "replace_conflict", false);
    case "registration_refused": return new DraftError(d ?? "The trial balance could not be added.", "failed", false);
    default: return new DraftError(DRAFT_MESSAGES.retry, "retry", true);
  }
}

export interface ReservedDraft { draftId: string; objectPath: string; expiresAt: string; replayed: boolean }

/** Step 1. `key` should be kept for this file until the upload has finished, so a retry reuses the same draft. */
export async function reserveDraft(file: File, key: string, contentSha256?: string): Promise<ReservedDraft> {
  if (file.size <= 0 || file.size > DRAFT_MAX_BYTES) throw new DraftError(DRAFT_MESSAGES.invalidFile, "invalid_file", false);
  const sha = contentSha256 ?? (await sha256Hex(file));
  const { data, error } = await draftRpc().rpc("reserve_trial_balance_draft", { p_file_name: file.name, p_file_size: file.size, p_content_sha256: sha, p_idempotency_key: key });
  if (error) {
    if (RPC_NOT_DEPLOYED.has(error.code ?? "")) throw new DraftError(DRAFT_MESSAGES.unavailable, "drafts_unavailable", false);
    throw new DraftError(DRAFT_MESSAGES.retry, "retry", true);
  }
  const r = data?.[0];
  if (r && (r.outcome === "reserved" || r.outcome === "replayed") && r.draft_id && r.object_path && r.expires_at) {
    return { draftId: r.draft_id, objectPath: r.object_path, expiresAt: r.expires_at, replayed: r.outcome === "replayed" };
  }
  if (r?.outcome === "invalid_request") throw new DraftError(DRAFT_MESSAGES.invalidFile, "invalid_file", false);
  throw refusal(r?.outcome);
}

/** Step 2. Safe to repeat: a draft whose file is already stored is not uploaded again. */
export async function uploadDraft(draft: ReservedDraft, file: File): Promise<void> {
  const reply = await invokeDraft({ action: "sign", draft_id: draft.draftId });
  if (notDeployed(reply)) throw new DraftError(DRAFT_MESSAGES.unavailable, "drafts_unavailable", false);
  const b = reply.body;
  if (b?.outcome === "already_stored") return;
  if (b?.outcome !== "signed" || typeof b.path !== "string" || typeof b.token !== "string") throw refusal(b?.outcome, b?.detail);
  if (b.path !== draft.objectPath) throw new DraftError(DRAFT_MESSAGES.retry, "retry", true);
  const { error } = await supabase.storage.from("trial-balance-files").uploadToSignedUrl(b.path, b.token, file);
  if (error) throw new DraftError("The file could not be uploaded. Please try again.", "upload_failed", true);
}

export interface CommitTarget {
  companyId: string;
  periodYear: number;
  periodId?: string | null;
  engagementId?: string | null;
  /** Exactly what the user confirmed on the confirmation card. */
  confirmation: { entity: string; period: string; currency: string };
  /** Replace the period's active trial balance (at the version the user saw); the current one is kept if this fails. */
  replaces?: { uploadId: string; expectedVersion: number } | null;
}

/** Step 3. Send the same `commitKey` on every retry of this commit; it is bound to this draft and target. */
export async function commitDraft(draftId: string, commitKey: string, target: CommitTarget): Promise<{ uploadId: string; commitId: string; replayed: boolean }> {
  const reply = await invokeDraft({
    action: "commit", draft_id: draftId, commit_key: commitKey, company_id: target.companyId, period_year: target.periodYear,
    period_id: target.periodId ?? null, engagement_id: target.engagementId ?? null, confirmation: target.confirmation,
    ...(target.replaces ? { replaces_upload_id: target.replaces.uploadId, expected_version: target.replaces.expectedVersion } : {}),
  });
  if (notDeployed(reply)) throw new DraftError(DRAFT_MESSAGES.unavailable, "drafts_unavailable", false);
  const b = reply.body;
  if (b?.outcome === "committed" && typeof b.upload_id === "string" && typeof b.commit_id === "string") {
    return { uploadId: b.upload_id, commitId: b.commit_id, replayed: b.replayed === true };
  }
  const e = refusal(b?.outcome, b?.detail);
  if (typeof b?.commit_id === "string") e.commitId = b.commit_id;
  throw e;
}

/** Cancels a commit that was never added (e.g. to choose another period). */
export async function cancelDraftCommit(commitId: string): Promise<void> {
  const reply = await invokeDraft({ action: "cancel", commit_id: commitId });
  if (notDeployed(reply)) throw new DraftError(DRAFT_MESSAGES.unavailable, "drafts_unavailable", false);
  const o = reply.body?.outcome;
  if (o === "cancelled" || o === "already_cancelled") return;
  throw refusal(o, reply.body?.detail);
}
