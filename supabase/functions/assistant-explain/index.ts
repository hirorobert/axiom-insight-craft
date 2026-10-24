// ============================================================
// assistant-explain Edge Function — Ask CFOClose Release 0.1
//
// Explains the movement of ONE statement line, or drafts commentary about it, from the statements the database composed.
// Advisory only: this function writes nothing but its own ai_assistant_runs record; it cannot change a classification,
// adjustment, evidence status, framework decision, approval, publication or report. The decisions are in
// _shared/assistantHandler.ts (facts, validation and rendering in assistantFacts.ts / assistantResponse.ts).
//
// EXTERNAL AI CALLS ARE OFF unless ALL of these hold: the server environment names the provider (ASSISTANT_PROVIDER=anthropic)
// and holds ANTHROPIC_API_KEY in secrets; ai_assistant_settings is enabled with both approvals recorded (migration
// 20261127100000); the workspace has enabled the assistant under the current terms; and it has a budget. Otherwise every
// request is refused before anything is sent. The statements are read with the PERSON'S token, so the database decides
// access; only the reservation and completion use the service role.
// ============================================================

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, validateAuth } from "../_shared/auth.ts";
import { handleAssistant } from "../_shared/assistantHandler.ts";
import { anthropicProvider, type AssistantProvider } from "../_shared/assistantProvider.ts";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function configuredProvider(): AssistantProvider | null {
  const name = Deno.env.get("ASSISTANT_PROVIDER");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  return name === "anthropic" && key ? anthropicProvider(key) : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization");
    const auth = await validateAuth(authHeader, corsHeaders);
    if (auth.error) return auth.error;
    const userId = auth.result!.userId;
    const body = await req.json().catch(() => null);

    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // The person's own client: the composition is read under their identity, exactly as the Statements page reads it.
    const asPerson = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader! } },
    });
    const out = await handleAssistant(userId, body, {
      provider: configuredProvider(),
      readComposition: async (companyId, periodYear) => {
        const { data, error } = await asPerson.rpc("fs_statement_composition", { p_company_id: companyId, p_period_year: periodYear });
        if (error) throw new Error(`fs_statement_composition failed: ${error.code ?? "unknown"}`);
        return data;
      },
      rpc: (name, args) => service.rpc(name, args),
      now: () => Date.now(),
    });
    // Every handled outcome (answered, refused, stale, unavailable, failed) is a 200 whose body carries status and code: the
    // reporting transport (src/lib/reporting/supabaseDb.ts) passes response bodies of successful calls only. 400 stays a
    // malformed request; a crash is a 500.
    return json(out.body, out.status === 400 ? 400 : 200);
  } catch (e) {
    // Identifiers and codes only: no financial payload is logged.
    console.error("[assistant-explain] failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return json({ status: "failed", code: "ASSISTANT_FAILED", message: "The assistant could not answer. Nothing was changed; your statements are unaffected." }, 500);
  }
});
