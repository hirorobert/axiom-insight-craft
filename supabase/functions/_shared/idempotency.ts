// Ω∞ Phase 0A — request idempotency claim lifecycle.
//
// Answers "should this request execute again?" — deliberately separate from
// engine-run.ts, which answers "what executed?". Concurrency safety comes
// entirely from idempotency_keys' database-enforced UNIQUE NULLS NOT
// DISTINCT (company_id, firm_member_id, function_name, client_request_id)
// constraint — never from a SELECT-then-INSERT race, and never from an
// advisory lock (unlike Phase 2A's per-account serialization, duplicate
// requests here have exactly one legitimate winner by construction).
//
// NOT executed/tested in this environment — no Deno runtime available here.

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
  | { outcome: "claimed"; keyId: string }
  | { outcome: "replay"; result: ReplayResult }
  | { outcome: "in_progress" }
  | { outcome: "conflict" };

interface ClaimParams {
  actor: FirmMemberActor | { userId: null; companyId: string }; // system actors have no firmMemberId
  actorType: "user" | "system";
  functionName: string;
  clientRequestId: string;
  requestHash: string;
  inputHash?: string | null;
}

/**
 * Attempts to claim an idempotency slot. Exactly one caller wins the
 * underlying INSERT for a given (company_id, firm_member_id, function_name,
 * client_request_id) — including when firm_member_id is NULL (system
 * actor), which UNIQUE NULLS NOT DISTINCT specifically protects.
 *
 * - "claimed": this call won the race. Proceed to execute the engine,
 *   using `keyId` to complete/fail the claim afterward.
 * - "replay": a prior call with the identical request_hash already reached
 *   a terminal state. Return `result` verbatim — do NOT execute again.
 * - "in_progress": a prior call with the identical request_hash is still
 *   reserved (in flight). Do not block the HTTP request indefinitely —
 *   return this to the caller, who may poll or retry the same
 *   client_request_id later.
 * - "conflict": the same client_request_id was used with a DIFFERENT
 *   request_hash. Hard reject — never silently reuse or overwrite.
 */
export async function claimIdempotency(
  adminClient: ReturnType<typeof createClient>,
  params: ClaimParams,
): Promise<ClaimOutcome> {
  const firmMemberId =
    params.actorType === "user" ? (params.actor as FirmMemberActor).firmMemberId : null;

  const { data: inserted, error: insertError } = await adminClient
    .from("idempotency_keys")
    .insert({
      company_id: params.actor.companyId,
      firm_member_id: firmMemberId,
      actor_type: params.actorType,
      function_name: params.functionName,
      client_request_id: params.clientRequestId,
      request_hash: params.requestHash,
      input_hash: params.inputHash ?? null,
    })
    .select("id")
    .single();

  if (!insertError && inserted) {
    return { outcome: "claimed", keyId: inserted.id as string };
  }

  // Unique violation (Postgres code 23505) — someone else already claimed
  // this exact identity. Look up what they claimed and decide.
  const { data: existing } = await adminClient
    .from("idempotency_keys")
    .select("request_hash, status, replay_result")
    .eq("company_id", params.actor.companyId)
    .eq("firm_member_id", firmMemberId)
    .eq("function_name", params.functionName)
    .eq("client_request_id", params.clientRequestId)
    .maybeSingle();

  if (!existing) {
    // Should not happen — the unique violation implies a row exists. Fail
    // closed rather than silently proceed as if unclaimed.
    return { outcome: "conflict" };
  }

  if (existing.request_hash !== params.requestHash) {
    return { outcome: "conflict" };
  }

  if (existing.status === "reserved") {
    return { outcome: "in_progress" };
  }

  // status is 'completed' or 'failed' — replay the recorded outcome.
  return {
    outcome: "replay",
    result: (existing.replay_result as ReplayResult) ?? {
      status: existing.status as "completed" | "failed",
    },
  };
}

/** Marks a claimed key as completed. The ONLY legal transition besides failIdempotency. */
export async function completeIdempotency(
  adminClient: ReturnType<typeof createClient>,
  keyId: string,
  engineRunId: string,
  result: ReplayResult,
): Promise<void> {
  const { error } = await adminClient
    .from("idempotency_keys")
    .update({
      status: "completed",
      engine_run_id: engineRunId,
      replay_result: result,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", keyId);
  if (error) throw error;
}

/** Marks a claimed key as failed. A retry requires a NEW client_request_id — this key is never reused. */
export async function failIdempotency(
  adminClient: ReturnType<typeof createClient>,
  keyId: string,
  engineRunId: string | null,
  errorCode: string,
): Promise<void> {
  const { error } = await adminClient
    .from("idempotency_keys")
    .update({
      status: "failed",
      engine_run_id: engineRunId,
      replay_result: { status: "failed", error_code: errorCode },
      resolved_at: new Date().toISOString(),
    })
    .eq("id", keyId);
  if (error) throw error;
}
