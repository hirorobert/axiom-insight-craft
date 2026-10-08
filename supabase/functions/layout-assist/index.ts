// ============================================================
// layout-assist Edge Function (I1-C)
//
// AI-assisted layout suggestions for a trial-balance file the automatic reading could not read. The decisions are in
// _shared/layoutAssist.ts; authorization and the file read are the trial-balance-layout handler's own (inspect), and the
// suggestion is validated against the whole file by its validate path.
//
// EXTERNAL AI CALLS ARE DISABLED: no provider adapter is wired here (provider: null), so every request is refused with
// PROVIDER_DISABLED before anything is read. Wiring a provider requires the approved provider configuration and
// data-handling terms, a measured evaluation, and the database gates (ai_provider_settings.enabled with both approvals
// recorded, workspace consent, budget) — each its own reviewed change.
// ============================================================

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX        from "https://esm.sh/xlsx@0.18.5";
import { corsHeaders, validateAuth } from "../_shared/auth.ts";
import { handleLayoutAssist } from "../_shared/layoutAssist.ts";
import type { LayoutUpload } from "../_shared/trialBalanceLayout.ts";
import type { XlsxLike } from "../_shared/tbSource.ts";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  try {
    const auth = await validateAuth(req.headers.get("Authorization"), corsHeaders);
    if (auth.error) return auth.error;
    const userId = auth.result!.userId;
    const body = await req.json().catch(() => null);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const rpc = (name: string, args: Record<string, unknown>) => supabase.rpc(name, args);
    const out = await handleLayoutAssist(userId, body, {
      provider: null,
      rpc,
      layout: {
        loadUpload: async (id) => {
          const { data, error } = await supabase.from("trial_balance_uploads")
            .select("id, company_id, file_path, file_name, lifecycle_state, period_year, period_id, engagement_id").eq("id", id).maybeSingle();
          if (error) throw new Error(`upload lookup failed: ${error.code ?? "unknown"}`);
          return data as LayoutUpload | null;
        },
        rpc,
        db: supabase as never,
        download: async (path) => {
          const { data, error } = await supabase.storage.from("trial-balance-files").download(path);
          return error || !data ? null : new Uint8Array(await data.arrayBuffer());
        },
        // The suggestion is validated in the period's currency exactly as a person's layout is (trial-balance-layout's rule).
        reportingCurrency: async (upload) => {
          const u = upload as LayoutUpload & { period_id?: string | null; engagement_id?: string | null };
          if (!u.company_id) return null;
          let periodId = u.period_id ?? null;
          if (!periodId && u.engagement_id) {
            const { data, error } = await supabase.from("engagements").select("fiscal_period_id, company_id").eq("id", u.engagement_id).maybeSingle();
            if (error) throw new Error(`engagement lookup failed: ${error.code ?? "unknown"}`);
            const e = data as { fiscal_period_id: string | null; company_id: string } | null;
            if (e && e.company_id === u.company_id) periodId = e.fiscal_period_id;
          }
          if (!periodId) return null;
          const { data, error } = await supabase.from("fiscal_periods").select("company_id, reporting_currency").eq("id", periodId).maybeSingle();
          if (error) throw new Error(`period lookup failed: ${error.code ?? "unknown"}`);
          const p = data as { company_id: string; reporting_currency: string | null } | null;
          return p && p.company_id === u.company_id && typeof p.reporting_currency === "string" && p.reporting_currency.trim() ? p.reporting_currency : null;
        },
        xlsx: XLSX as unknown as XlsxLike,
      },
    });
    return json(out.body, out.status);
  } catch (e) {
    console.error("[layout-assist] failed", e instanceof Error ? e.message : "unknown");
    return json({ status: "error", code: "LAYOUT_ASSIST_FAILED", message: "No suggestion could be produced. Nothing was changed; set the layout manually." }, 500);
  }
});
