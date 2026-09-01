// Ω∞ Phase 0A — engine_runs terminal-transition client (HARDENED).
//
// CORRECTED (Phase 0A-1R): recordEngineRunStart is REMOVED. Creating the
// engine_runs row is now claimIdempotency()'s responsibility (see
// idempotency.ts) — the run and its idempotency claim are created together,
// with engine_run_id bound in the same insert as the claim, never a
// separate later step. This module now only completes the one legal
// terminal transition.
//
// NOT executed/tested in this environment — no Deno runtime available here
// beyond `deno check`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// The Supabase client here has no Database generic (matching the existing
// _shared/auth.ts pattern), so .update() payloads type-check against
// `never` with no schema to validate against. `as never` on the payload is
// the established workaround already used in this codebase for exactly
// this class of friction (see AccountReviewPanel.tsx's
// resolve_account_review_batch call) — it does not weaken runtime
// behavior, only a compile-time check the generic-less client cannot
// perform without generated types for these new tables.

/** The one legal running->completed transition. */
export async function recordEngineRunComplete(
  adminClient: ReturnType<typeof createClient>,
  engineRunId: string,
  params: { outputHash: string; startedAt: string },
): Promise<void> {
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - new Date(params.startedAt).getTime();

  const { error } = await adminClient
    .from("engine_runs")
    .update({
      status: "completed",
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      output_hash: params.outputHash,
    } as never)
    .eq("id", engineRunId);
  if (error) throw error;
}

/**
 * The one legal running->failed transition. errorDetail must be structured
 * and bounded — matches chk_er_error_detail_bounded exactly (stage,
 * safe_message, reference_id only). Never pass a raw Error object, a stack
 * trace, request headers, or auth material — those must go to console
 * logging (ephemeral), never into this durable, RLS-readable table.
 */
export async function recordEngineRunFailed(
  adminClient: ReturnType<typeof createClient>,
  engineRunId: string,
  params: {
    startedAt: string;
    errorCode: string;
    errorDetail?: { stage?: string; safe_message?: string; reference_id?: string } | null;
  },
): Promise<void> {
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - new Date(params.startedAt).getTime();

  const { error } = await adminClient
    .from("engine_runs")
    .update({
      status: "failed",
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      error_code: params.errorCode,
      error_detail: params.errorDetail ?? null,
    } as never)
    .eq("id", engineRunId);
  if (error) throw error;
}
