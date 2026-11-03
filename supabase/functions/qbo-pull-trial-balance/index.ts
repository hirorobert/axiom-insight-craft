// qbo-pull-trial-balance: one user-initiated import of a connected QuickBooks Online company's Trial Balance into a workspace (charter B9).
//
// A connector is another SOURCE OF THE SAME FILE. The function refreshes the stored token (the new refresh token is stored by compare-and-swap BEFORE the new access
// token is used), fetches the report through the read-only guard, converts it with qboTrialBalance (refused, never repaired, if it is not exactly the recorded shape),
// and hands the canonical CSV to the SAME upload steps a manual file uses: reserve_trial_balance_source and register_trial_balance_upload run AS THE PERSON (their own
// token, so each judges that person), and the existing processing and review gates then apply unchanged. The evidence (qbo_record_pull_intent) is written BEFORE
// the file is stored and linked to the upload afterwards (qbo_complete_pull, idempotent and recoverable). The service-role
// key, the tokens, the envelope key and the QuickBooks response never leave the function and are never logged. See _shared/qboPull.ts for the order and its reasons.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { parsePullRequest, REFRESH_LEASE_SECONDS, runQboPull, type CompletePullResult } from "../_shared/qboPull.ts";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { createGuardedQboFetch, qboReportUrl, qboPreferencesUrl } from "../_shared/qboReadOnlyGuard.ts";
import { sha256Hex, summariseCanonicalCsv } from "../_shared/qboPullSummary.ts";
import { createQboTokenClient } from "../_shared/qboTokenClient.ts";
import { openSecret, sealSecret } from "../_shared/qboTokenEnvelope.ts";

import { boundedQboRead } from "../_shared/qboBoundedRead.ts";

const BUCKET = "trial-balance-files";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const config = readQboEnv((n) => Deno.env.get(n));
  const keys = config.keys();
  if (!url || !serviceKey || !anonKey || !keys) return json(503, { outcome: "not_configured" });

  const parsed = parsePullRequest(await req.json().catch(() => null));
  if (!parsed) return json(400, { outcome: "invalid_request" });
  const creds = config.credentials(parsed.environment);
  if (!creds) return json(503, { outcome: "not_configured" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // The upload steps run as the person: their own token, so reserve and register judge THEM, exactly as for a file they upload by hand.
  const asPerson = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const guardedFetch = createGuardedQboFetch((u, init) => fetch(u, init));
  const tokens = createQboTokenClient(guardedFetch, creds);
  let actor: string | null = null;
  // workspace_authority_basis(user, company, capability) is not null. Both rights an import needs are judged here, on the server, from the verified login.
  const hasCapability = async (userId: string, companyId: string, capability: string): Promise<boolean> => {
    const { data, error } = await service.rpc("workspace_authority_basis", { p_user_id: userId, p_company_id: companyId, p_capability: capability });
    return !error && typeof data === "string" && data.length > 0;
  };

  const result = await runQboPull({
    authenticate: async () => {
      if (!token) return null;
      const { data, error } = await service.auth.getUser(token);
      actor = error ? null : data.user?.id ?? null;
      return actor;
    },
    savedPeriod: async (userId, request) => {
      const { data, error } = await service.rpc("qbo_saved_period", { p_actor: userId, p_company: request.companyId, p_period: request.periodId, p_year: request.periodYear, p_engagement: request.engagementId });
      return !error && data ? data : null;
    },
    connectionActive: async (id) => {
      const { data, error } = await service.from("qbo_connections").select("status").eq("id", id).maybeSingle();
      return !error && data?.status === "active";
    },
    fetchPreferences: (environment, realmId, accessToken) => boundedQboRead(guardedFetch, {
      method: "GET", url: qboPreferencesUrl(environment, realmId, config.minorVersion), headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    }),
    canPrepare: (userId, companyId) => hasCapability(userId, companyId, "prepare_trial_balance"),
    canManageSources: (userId, companyId) => hasCapability(userId, companyId, "manage_source_files"),
    acquireRefreshLease: async (connectionId, envelope) => {
      const { data, error } = await service.rpc("qbo_acquire_refresh_lease", { p_connection_id: connectionId, p_expected_envelope: envelope, p_seconds: REFRESH_LEASE_SECONDS });
      if (error) throw error;
      return typeof data === "string" && data.length > 0 ? data : null;   // the lease's own id, or null when another import holds it
    },
    releaseRefreshLease: async (connectionId, leaseId) => { await service.rpc("qbo_release_refresh_lease", { p_connection_id: connectionId, p_lease_id: leaseId }); },
    completePending: async () => { await service.rpc("qbo_complete_pending_pulls"); },
    findConnection: async (companyId, realmId, environment) => {
      const { data, error } = await service.from("qbo_connections").select("id, status, refresh_token_envelope")
        .eq("company_id", companyId).eq("realm_id", realmId).eq("environment", environment).neq("status", "disconnected").maybeSingle();
      if (error) throw error;
      return data ? { id: data.id as string, status: data.status as "active" | "reconnect_needed", envelope: (data.refresh_token_envelope as string | null) ?? null } : null;
    },
    openRefreshToken: async (envelope, binding) => { try { return await openSecret(envelope, keys.all, binding); } catch { return null; } },
    refresh: (_environment, refreshToken) => tokens.refresh(refreshToken),
    sealRefreshToken: (refreshToken, binding) => sealSecret(refreshToken, keys.current, binding),
    rotate: async (connectionId, expected, next, refreshExpiresAt, hardExpiresAt, leaseId) => {
      const { data, error } = await service.rpc("qbo_rotate_leased_token", { p_lease_id: leaseId, p_connection_id: connectionId, p_expected_envelope: expected, p_new_envelope: next, p_refresh_expires_at: refreshExpiresAt, p_hard_expires_at: hardExpiresAt });
      if (error) throw error;
      return data === true;
    },
    markReconnectNeeded: async (connectionId, refusedEnvelope) => { await service.rpc("qbo_mark_reconnect_needed", { p_connection_id: connectionId, p_refused_envelope: refusedEnvelope }); },
    fetchReport: async (environment, realmId, accessToken, p) => {
      return boundedQboRead(guardedFetch, {
        method: "GET",
        url: qboReportUrl({ environment, realmId, startDate: p.startDate, endDate: p.endDate, accountingMethod: p.accountingMethod, minorVersion: config.minorVersion }),
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
    },
    sha256Hex,
    summarise: summariseCanonicalCsv,
    reserve: async (companyId, fileName) => {
      const { data, error } = await asPerson.rpc("reserve_trial_balance_source", { p_company_id: companyId, p_file_name: fileName });
      const r = Array.isArray(data) ? data[0] : null;
      if (error || !r) return { ok: false as const, reason: "failed" as const };
      if (r.outcome === "forbidden") return { ok: false as const, reason: "forbidden" as const };
      return r.outcome === "reserved" && r.reservation_id && r.object_path ? { ok: true as const, reservationId: r.reservation_id as string, objectPath: r.object_path as string } : { ok: false as const, reason: "failed" as const };
    },
    putObject: async (path, bytes) => {
      const { error } = await service.storage.from(BUCKET).upload(path, bytes, { upsert: false, contentType: "text/csv" });
      return !error;
    },
    removeObject: async (path) => { await service.storage.from(BUCKET).remove([path]); },
    register: async (reservationId, fileSize, periodYear, periodId, engagementId) => {
      const { data, error } = await asPerson.rpc("register_trial_balance_upload", { p_reservation_id: reservationId, p_file_size: fileSize, p_period_year: periodYear, p_period_id: periodId, p_engagement_id: engagementId });
      const r = Array.isArray(data) ? data[0] : null;
      return error || !r ? { outcome: "unconfirmed", uploadId: null } : { outcome: String(r.outcome), uploadId: (r.upload_id as string | null) ?? null };
    },
    recordIntent: async (r) => {
      const { error } = await service.rpc("qbo_record_fiscal_pull_intent", {
        p_period_id: r.periodId, p_fiscal_basis: r.fiscalBasis,
        p_reservation_id: r.reservationId, p_connection_id: r.connectionId, p_actor_user_id: r.actorUserId, p_realm_id: r.realmId, p_environment: r.environment,
        p_start_date: r.startDate, p_end_date: r.endDate, p_accounting_method: r.accountingMethod, p_minor_version: r.minorVersion, p_currency: r.currency,
        p_account_count: r.accountCount, p_raw_sha256: r.rawSha256, p_canonical_sha256: r.canonicalSha256, p_result_sha256: r.resultSha256,
      });
      if (error) throw error;
    },
    completePull: async (reservationId) => {
      const { data, error } = await service.rpc("qbo_complete_pull", { p_reservation_id: reservationId });
      if (error) throw error;
      return data as CompletePullResult;
    },
    minorVersion: config.minorVersion,
  }, parsed).catch(() => ({ status: 500 as const, outcome: "pull_failed" }));

  // OPERATIONAL LOG: never a token, an envelope or any part of the report.
  console.log(JSON.stringify({ event: "qbo.pull", status: result.status, outcome: result.outcome }));
  const { status, ...body } = result;
  return json(status, body);
});
