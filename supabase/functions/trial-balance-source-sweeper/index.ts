// trial-balance-source-sweeper: the scheduled, server-only sweep of trial balance source objects.
//
// Invoked by the database (pg_cron -> public.tbu_run_source_sweeper() -> pg_net) with a single-use ticket the
// database minted; no user, no stored key, no browser. Deployed with JWT verification off because the ticket is
// the credential: it is redeemed (once, within 5 minutes) before anything else runs.
// It purges terminal discards, finishes abandoned cancel-replacement cleanups and reclaims objects left by expired,
// unconsumed reservations: exactly what tbu_sweeper_candidates() lists, verified absent before completion.
// See _shared/sourceSweeper.ts for the decision sequence.

import { createClient } from "npm:@supabase/supabase-js@2";
import { parseSweeperRequest, runSourceSweep, type SweepCandidate } from "../_shared/sourceSweeper.ts";

const BUCKET = "trial-balance-files";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(503, { outcome: "sweep_failed" });

  const parsed = parseSweeperRequest(await req.json().catch(() => null));
  if (!parsed) return json(400, { outcome: "invalid_request" });

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const result = await runSourceSweep({
    redeemTicket: async (ticket) => {
      const { data, error } = await service.rpc("tbu_redeem_source_sweeper_ticket", { p_token: ticket });
      return !error && data === true;
    },
    listCandidates: async (limit) => {
      const { data, error } = await service.rpc("tbu_sweeper_candidates", { p_limit: limit });
      if (error) throw error;
      return (data ?? []) as SweepCandidate[];
    },
    claim: async (kind, targetId) => {
      const { data, error } = await service.rpc("tbu_sweeper_claim", { p_kind: kind, p_target_id: targetId });
      return !error && data === "claimed";
    },
    removeObject: async (path) => {
      const { error } = await service.storage.from(BUCKET).remove([path]);
      return !error;
    },
    objectExists: async (path) => {
      const { data, error } = await service.rpc("tbu_storage_object_exists", { p_path: path });
      return error ? null : data === true;
    },
    complete: async (kind, targetId) => {
      const { data, error } = await service.rpc("tbu_sweeper_complete", { p_kind: kind, p_target_id: targetId });
      return error ? null : (data as string | null);
    },
  }, parsed.ticket).catch(() => ({ status: 500, outcome: "sweep_failed" as const }));

  console.log(JSON.stringify({ event: "trial_balance.source_sweep", status: result.status, outcome: result.outcome, ...("tally" in result ? result.tally : {}) }));
  return json(result.status, result);
});
