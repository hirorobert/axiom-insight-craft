// Ω∞ Phase 0A — request idempotency claim lifecycle (HARDENED).
//
// Answers "should this request execute again?" — deliberately separate from
// engine-run.ts's "what executed?". Concurrency safety comes entirely from
// idempotency_keys' database-enforced UNIQUE NULLS NOT DISTINCT
// (company_id, firm_member_id, function_name, client_request_id)
// constraint — never a SELECT-then-INSERT race, never an advisory lock.
//
// CORRECTED (Phase 0A-1R): the engine_runs row is created FIRST, and its id
// bound into idempotency_keys.engine_run_id in the SAME insert that claims
// the reservation — never a later UPDATE while status='reserved'. If the
// claim is then lost to a concurrent winner, the just-created engine_runs
// row (which this call alone owns) is immediately failed with a specific
// reason, rather than left orphaned at 'running' forever. This also means
// an "in_progress" reply can now identify the actual active run.
//
// NOT executed/tested in this environment — no Deno runtime available here
// beyond `deno check` (see supabase/functions/_shared/DENO_CHECK_NOTES.md
// for what was and was not verified).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { FirmMemberActor } from "./actor.ts";

export type ReplayResult = {
  status: "completed" | "failed";
  reference_id?: string;
  reference_table?: string;
  summary?: Record<string, unknown>;
  error_code?: string;
};

export type ClaimOutcome =
  | { outcome: "claimed"; keyId: string; engineRunId: string; startedAt: string }
  | { outcome: "replay"; result: ReplayResult }
  | { outcome: "in_progress"; engineRunId: string }
  | { outcome: "conflict" };

interface ClaimParams {
  companyId: string;
  actor: FirmMemberActor | null; // null for system-triggered runs
  actorType: "user" | "system";
  functionName: string;
  engineVersion: string;
  ruleVersion?: string | null;
  clientRequestId: string;
  requestHash: string;
  inputHash?: string | null;
  periodYear?: number | null;
  sourceTable?: string | null;
  sourceRecordId?: string | null;
}

/**
 * Attempts to claim an idempotency slot. See ClaimOutcome for the four
 * possible results and required caller behavior for each — never silently
 * re-execute on "replay", never block indefinitely on "in_progress", never
 * reuse a different payload's result on "conflict".
 */
export async function claimIdempotency(
  adminClient: ReturnType<typeof createClient>,
  params: ClaimParams,
): Promise<ClaimOutcome> {
  const firmMemberId = params.actorType === "user" ? (params.actor as FirmMemberActor).firmMemberId : null;

  // Step 1: create the engine_runs row FIRST. This call becomes the
  // provisional executor; if it loses the idempotency race below, this row
  // is immediately marked failed with a specific reason (see below) —
  // never left stuck at 'running'.
  // The Supabase client here has no Database generic (matching the existing
  // _shared/auth.ts pattern), so .insert()/.update() payloads type-check
  // against `never`/`never[]` with no schema to validate against. `as never`
  // on the payload is the established workaround already used in this
  // codebase for exactly this class of friction (see AccountReviewPanel.tsx's
  // resolve_account_review_batch call) — it does not weaken runtime
  // behavior, only the compile-time check the generic-less client cannot
  // perform without generated types for these new tables.
  const { data: runData, error: runError } = await adminClient
    .from("engine_runs")
    .insert({
      company_id: params.companyId,
      firm_member_id: firmMemberId,
      actor_type: params.actorType,
      function_name: params.functionName,
      engine_version: params.engineVersion,
      rule_version: params.ruleVersion ?? null,
      input_hash: params.inputHash ?? null,
      period_year: params.periodYear ?? null,
      source_table: params.sourceTable ?? null,
      source_record_id: params.sourceRecordId ?? null,
    } as never)
    .select("id, started_at")
    .single();

  if (runError || !runData) throw runError ?? new Error("claimIdempotency: engine_runs insert returned no row");
  // No Database generic is configured for this client (matches the existing
  // _shared/auth.ts pattern), so query results type as `never` for field
  // access — one cast on the whole row, not per-field casts.
  const run = runData as { id: string; started_at: string };

  // Step 2: attempt to claim the idempotency slot, with engine_run_id bound
  // in this SAME insert — never a later update while status='reserved'.
  const { data: claimedData, error: claimError } = await adminClient
    .from("idempotency_keys")
    .insert({
      company_id: params.companyId,
      firm_member_id: firmMemberId,
      actor_type: params.actorType,
      function_name: params.functionName,
      client_request_id: params.clientRequestId,
      request_hash: params.requestHash,
      input_hash: params.inputHash ?? null,
      engine_run_id: run.id,
    } as never)
    .select("id")
    .single();

  if (!claimError && claimedData) {
    const claimed = claimedData as { id: string };
    return { outcome: "claimed", keyId: claimed.id, engineRunId: run.id, startedAt: run.started_at };
  }

  // Lost the race — fail the orphaned engine_runs row this call created.
  // A running->failed transition on a row this call owns is always legal.
  await adminClient
    .from("engine_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      duration_ms: 0,
      error_code: "IDEMPOTENCY_LOST_RACE",
    } as never)
    .eq("id", run.id);

  // Look up the winner. NOTE: `.eq("firm_member_id", null)` would compile
  // to `WHERE firm_member_id = NULL`, which never matches in SQL — the
  // system-actor case genuinely needs `.is(...)`, not `.eq(...)`.
  let existingQuery = adminClient
    .from("idempotency_keys")
    .select("request_hash, status, replay_result, engine_run_id")
    .eq("company_id", params.companyId)
    .eq("function_name", params.functionName)
    .eq("client_request_id", params.clientRequestId);
  existingQuery = firmMemberId === null
    ? existingQuery.is("firm_member_id", null)
    : existingQuery.eq("firm_member_id", firmMemberId);
  const { data: existingData } = await existingQuery.maybeSingle();

  if (!existingData) {
    // Should not happen — the unique violation implies a row exists.
    // Fail closed rather than silently proceed as if unclaimed.
    return { outcome: "conflict" };
  }
  const existing = existingData as {
    request_hash: string;
    status: "reserved" | "completed" | "failed";
    replay_result: ReplayResult | null;
    engine_run_id: string;
  };

  if (existing.request_hash !== params.requestHash) {
    return { outcome: "conflict" };
  }

  if (existing.status === "reserved") {
    return { outcome: "in_progress", engineRunId: existing.engine_run_id };
  }

  return {
    outcome: "replay",
    result: existing.replay_result ?? { status: existing.status },
  };
}

/** Marks a claimed key as completed. engine_run_id is already bound — this never touches it. */
export async function completeIdempotency(
  adminClient: ReturnType<typeof createClient>,
  keyId: string,
  result: ReplayResult,
): Promise<void> {
  const { error } = await adminClient
    .from("idempotency_keys")
    .update({
      status: "completed",
      replay_result: result,
      resolved_at: new Date().toISOString(),
    } as never)
    .eq("id", keyId);
  if (error) throw error;
}

/** Marks a claimed key as failed. A retry requires a NEW client_request_id — this key is never reused. */
export async function failIdempotency(
  adminClient: ReturnType<typeof createClient>,
  keyId: string,
  errorCode: string,
): Promise<void> {
  const { error } = await adminClient
    .from("idempotency_keys")
    .update({
      status: "failed",
      replay_result: { status: "failed", error_code: errorCode },
      resolved_at: new Date().toISOString(),
    } as never)
    .eq("id", keyId);
  if (error) throw error;
}
