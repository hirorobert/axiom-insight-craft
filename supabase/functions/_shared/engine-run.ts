// Ω∞ Phase 0A — engine_runs reproducibility ledger client.
//
// Answers "what executed?" — separate from idempotency.ts's "should this
// run again?". A row is created only once execution genuinely begins (the
// "should we start" decision already happened via claimIdempotency).
//
// NOT executed/tested in this environment — no Deno runtime available here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { FirmMemberActor } from "./actor.ts";

interface StartParams {
  actor: FirmMemberActor | { userId: null; companyId: string };
  actorType: "user" | "system";
  functionName: string;
  engineVersion: string;   // deployed function's git commit SHA — see DEPLOY_GIT_SHA
  ruleVersion?: string | null;
  requestId?: string | null;
  inputHash?: string | null;
  periodYear?: number | null;
  sourceTable?: string | null;
  sourceRecordId?: string | null;
}

export async function recordEngineRunStart(
  adminClient: ReturnType<typeof createClient>,
  params: StartParams,
): Promise<{ engineRunId: string; startedAt: string }> {
  const firmMemberId =
    params.actorType === "user" ? (params.actor as FirmMemberActor).firmMemberId : null;

  const { data, error } = await adminClient
    .from("engine_runs")
    .insert({
      company_id: params.actor.companyId,
      firm_member_id: firmMemberId,
      actor_type: params.actorType,
      function_name: params.functionName,
      engine_version: params.engineVersion,
      rule_version: params.ruleVersion ?? null,
      request_id: params.requestId ?? null,
      input_hash: params.inputHash ?? null,
      period_year: params.periodYear ?? null,
      source_table: params.sourceTable ?? null,
      source_record_id: params.sourceRecordId ?? null,
    })
    .select("id, started_at")
    .single();

  if (error || !data) throw error ?? new Error("recordEngineRunStart: insert returned no row");
  return { engineRunId: data.id as string, startedAt: data.started_at as string };
}

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
    })
    .eq("id", engineRunId);
  if (error) throw error;
}

/** The one legal running->failed transition. error_detail must be structured
 *  and scrubbed — never a raw exception object, never a stack trace, never
 *  request headers or auth material. Callers pass only whitelisted fields. */
export async function recordEngineRunFailed(
  adminClient: ReturnType<typeof createClient>,
  engineRunId: string,
  params: {
    startedAt: string;
    errorCode: string;
    errorDetail?: { message?: string; hint?: string } | null;
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
    })
    .eq("id", engineRunId);
  if (error) throw error;
}
