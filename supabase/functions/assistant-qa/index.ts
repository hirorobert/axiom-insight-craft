import { createClient } from "https://esm.sh/@supabase/supabase-js@2.86.2";
import { corsHeaders, validateAuth } from "../_shared/auth.ts";
import { QA_COMPANY, qaCaseId } from "../_shared/assistantQaPolicy.ts";

// Access preflight only. This endpoint reads no financial records, no provider key, and cannot spend.
// Explicit tester enrollment is not installed yet: only the persisted demo company owner qualifies.
Deno.serve(async req => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
  if (req.method === "OPTIONS") return reply(null);
  if (req.method !== "POST") return reply({ code: "METHOD_NOT_ALLOWED" }, 405);
  const header = req.headers.get("Authorization");
  const auth = await validateAuth(header, corsHeaders);
  if (auth.error) return auth.error;
  if (!auth.result || !header) return reply({ allowed: false }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) return reply({ allowed: false, code: "UNAVAILABLE" }, 503);
  const client = createClient(url, key, { global: { headers: { Authorization: header } }, auth: { persistSession: false } });
  const { data: company, error } = await client.from("companies").select("id,user_id").eq("id", QA_COMPANY).maybeSingle();
  if (error) return reply({ allowed: false, code: "QA_UNAVAILABLE" }, 503);
  if (!company || company.user_id !== auth.result.userId) return reply({ allowed: false }, 403);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ code: "INVALID_REQUEST" }, 400);
  if (body.action === "status" && Object.keys(body).length === 1) return reply({ allowed: true, spendingEnabled: false });
  if (!qaCaseId(body.caseId) || !["explain_movement", "draft_commentary"].includes(body.action)) return reply({ code: "INVALID_REQUEST" }, 400);
  return reply({ status: "refused", code: "QA_SPENDING_PAUSED", message: "API spending is paused until remaining provider credits and the evaluation configuration are confirmed." });
});