// ============================================================
// trial-balance-layout Edge Function (I1-A, A2)
//
// The manual layout editor's server: inspect a trial-balance file, validate a layout against the whole file, confirm a
// layout for an upload (append-only, bound to the file's source hash and the resolved layout hash) and save reusable
// layout templates. The decisions are in _shared/trialBalanceLayout.ts; this file only wires Supabase.
//
// Authentication: the caller's JWT (validateAuth). The service-role client is used for reads and for the two writer
// functions, which derive the actor from the JWT user and enforce prepare_close themselves; nothing in the request body
// names an actor. No financial table is written here — only layout_templates and layout_confirmations.
// ============================================================

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX        from "https://esm.sh/xlsx@0.18.5";
import { corsHeaders, validateAuth } from "../_shared/auth.ts";
import { handleLayoutRequest, type LayoutUpload } from "../_shared/trialBalanceLayout.ts";
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
    const out = await handleLayoutRequest(userId, body, {
      loadUpload: async (id) => {
        const { data, error } = await supabase.from("trial_balance_uploads")
          .select("id, company_id, file_path, file_name, lifecycle_state, period_year, period_id, engagement_id").eq("id", id).maybeSingle();
        if (error) throw new Error(`upload lookup failed: ${error.code ?? "unknown"}`);
        return data as LayoutUpload | null;
      },
      rpc: (name, args) => supabase.rpc(name, args),
      db: supabase as never,
      download: async (path) => {
        const { data, error } = await supabase.storage.from("trial-balance-files").download(path);
        return error || !data ? null : new Uint8Array(await data.arrayBuffer());
      },
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
    });
    return json(out.body, out.status);
  } catch (e) {
    // Never a raw error to the caller; nothing was written by a failed request (the writers are single statements).
    console.error("[trial-balance-layout] failed", e instanceof Error ? e.message : "unknown");
    return json({ status: "error", code: "LAYOUT_REQUEST_FAILED", message: "The layout request could not be completed. Nothing was changed." }, 500);
  }
});
