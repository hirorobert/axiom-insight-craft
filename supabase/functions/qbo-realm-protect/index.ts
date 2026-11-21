// qbo-realm-protect: the one-off backfill and verification of QuickBooks realmIDs stored before the protection release (Intuit case 00232331;
// docs/release/qbo-realm-protection-r1/README.md). ONLY A SIGNED-IN ACTIVE PLATFORM OWNER may run it: the caller's own session proves who they
// are (_shared/auth.ts validateAuth: signature, expiry and a user subject), and the database's own public.is_platform_owner(user) decides
// authority. Lovable Cloud never discloses the service-role credential, so nothing here asks for it; a service-role or anon token has no user
// and is refused, as is every member, commercial-tier administrator or inactive owner. Only after that decision does this function use its
// own service client, for the service-only database functions. POST { "action": "protect" } seals each live connection's and each disconnect
// operation's realm and submits it; POST { "action": "verify" } opens every envelope, compares it with the stored plaintext and the index, and
// marks the row verified. POST { "action": "keys" } (read only) opens every live realm envelope and refresh token and every operation's realm
// envelope and counts them by key id; POST { "action": "reseal" } moves every live row still sealed with an older token key onto the current
// sealing key (QBO_TOKEN_KEY_NEXT_*), by compare-and-swap (20261230400000). POST { "action": "index_keys" } (read only) counts every live
// connection's and operation's stored index by index key id; POST { "action": "reindex" } moves every such index made by an older index key
// onto the current one (QBO_REALM_INDEX_KEY_NEXT_*), by compare-and-swap (20261230500000). Repeating, running concurrently or resuming after an
// interruption is safe (see _shared/qboRealmBackfill.ts). AFTER THE CUTOVER (20261231100000-20261231300000) the plaintext realm is never read
// and the database writers that compared it are gone: "verify" opens every envelope and recomputes its index (nothing written), "protect" only
// reports rows without protection, and "reseal"/"reindex" move keys without any plaintext. The answer and the log carry COUNTS only: never a
// realm, an envelope, an index, a key or a row id.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, validateAuth } from "../_shared/auth.ts";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { decideMaintenanceAuthority, parseBackfillRequest, runRealmBackfill, type BackfillRow } from "../_shared/qboRealmBackfill.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-cache, no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { ...corsHeaders, "Cache-Control": "no-cache, no-store" } });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const realmKeys = readQboEnv((n) => Deno.env.get(n)).realmKeys();
  if (!url || !serviceKey || !Deno.env.get("SUPABASE_ANON_KEY") || !realmKeys) return json(503, { outcome: "not_configured" });

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const authority = await decideMaintenanceAuthority(req.headers.get("Authorization"), {
    userIdOf: async (header) => (await validateAuth(header, corsHeaders)).result?.userId ?? null,
    isPlatformOwner: async (userId) => {
      const { data, error } = await service.rpc("is_platform_owner", { p_user: userId });
      if (error) throw error;
      return data;
    },
  });

  const rpc = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const { data, error } = await service.rpc(name, args);
    if (error) throw error;
    return String(data);
  };
  const rows = (data: unknown[] | null, id: string): BackfillRow[] => (data ?? []).map((r) => {
    const x = r as Record<string, unknown>;
    return { id: x[id] as string, company_id: x.company_id as string, environment: x.environment as "production" | "sandbox",
      realm_id: null, realm_envelope: (x.realm_envelope as string | null) ?? null, realm_index: (x.realm_index as string | null) ?? null,
      refresh_token_envelope: (x.refresh_token_envelope as string | null) ?? null };
  });

  const result = await runRealmBackfill({
    authorize: async () => authority,
    listConnections: async () => {
      const { data, error } = await service.from("qbo_connections").select("id, company_id, environment, realm_envelope, realm_index, refresh_token_envelope").neq("status", "disconnected");
      if (error) throw error;
      return rows(data, "id");
    },
    listOperations: async () => {
      const { data, error } = await service.from("qbo_disconnect_operations").select("connection_id, company_id, environment, realm_envelope, realm_index");
      if (error) throw error;
      return rows(data, "connection_id");
    },
    status: async () => {
      const { data, error } = await service.rpc("qbo_realm_protection_status");
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
    resealConnection: (a) => rpc("qbo_reseal_connection_realm", { ...a }),
    resealOperation: (a) => rpc("qbo_reseal_disconnect_realm", { ...a }),
    resealToken: (a) => rpc("qbo_reseal_refresh_token", { ...a }),
    coverage: async () => {
      const { data, error } = await service.rpc("qbo_realm_key_coverage");
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
    reindexConnection: (a) => rpc("qbo_reindex_connection_realm", { ...a }),
    reindexOperation: (a) => rpc("qbo_reindex_disconnect_realm", { ...a }),
    indexCoverage: async () => {
      const { data, error } = await service.rpc("qbo_realm_index_coverage");
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  }, realmKeys, parseBackfillRequest(await req.json().catch(() => null))).catch(() => ({ status: 500 as const, outcome: "failed" as const }));

  // OPERATIONAL LOG: who ran it (a user id, never a credential), the outcome and counts only.
  console.log(JSON.stringify({ event: "qbo.realm_protect", status: result.status, outcome: result.outcome, actor: authority.ok ? authority.actor : null,
    ...("connections" in result ? { action: result.action, connections: result.connections, operations: result.operations } : {}),
    ...("refreshTokens" in result ? { action: result.action, currentKeyId: result.currentKeyId, connectionRealms: result.connectionRealms, refreshTokens: result.refreshTokens, operationRealms: result.operationRealms } : {}),
    ...("connectionIndexes" in result ? { action: result.action, currentIndexKeyId: result.currentIndexKeyId, connectionIndexes: result.connectionIndexes, operationIndexes: result.operationIndexes } : {}) }));
  const { status, ...body } = result;
  return json(status, body);
});
