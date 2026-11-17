// qbo-realm-protect: the one-off, SERVICE-ONLY backfill and verification of QuickBooks realmIDs stored before the protection release (Intuit case
// 00232331; docs/release/qbo-realm-protection-r1/README.md). No browser, no member: the caller must present the service-role credential itself
// (compared in constant time with this runtime's own), so nothing here is reachable with a member's sign-in, and every database function it calls is
// service-role only. AFTER THE CUTOVER there is no plaintext and no database writer: POST { "action": "verify" } opens every live connection's and
// every disconnect operation's envelope and recomputes its index (counts only, nothing written); POST { "action": "protect" } only reports rows
// without protection (there must be none). The answer and the log carry COUNTS only: never a realm, an envelope, an index, a key or a row id.
// See _shared/qboRealmBackfill.ts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { parseBackfillRequest, runRealmBackfill, sameCredential, type BackfillRow } from "../_shared/qboRealmBackfill.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-cache, no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const realmKeys = readQboEnv((n) => Deno.env.get(n)).realmKeys();
  if (!url || !serviceKey || !realmKeys) return json(503, { outcome: "not_configured" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const rows = (data: unknown[] | null, id: string): BackfillRow[] => (data ?? []).map((r) => {
    const x = r as Record<string, unknown>;
    return { id: x[id] as string, company_id: x.company_id as string, environment: x.environment as "production" | "sandbox",
      realm_id: null, realm_envelope: (x.realm_envelope as string | null) ?? null, realm_index: (x.realm_index as string | null) ?? null };
  });

  const result = await runRealmBackfill({
    authorize: () => sameCredential(presented, serviceKey),
    listConnections: async () => {
      const { data, error } = await service.from("qbo_connections").select("id, company_id, environment, realm_envelope, realm_index").neq("status", "disconnected");
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
  }, realmKeys, parseBackfillRequest(await req.json().catch(() => null))).catch(() => ({ status: 500 as const, outcome: "failed" as const }));

  // OPERATIONAL LOG: counts only.
  console.log(JSON.stringify({ event: "qbo.realm_protect", status: result.status, outcome: result.outcome,
    ...("connections" in result ? { action: result.action, connections: result.connections, operations: result.operations } : {}) }));
  const { status, ...body } = result;
  return json(status, body);
});
