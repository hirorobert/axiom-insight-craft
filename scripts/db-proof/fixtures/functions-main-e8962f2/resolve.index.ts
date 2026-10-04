/**
 * safisha-resolve · IRON DOME NUCLEAR DESIGN · Stage 5
 *
 * THE ONLY function permitted to write a resolved reviewer_action.
 *
 * It calls the safisha_resolve_exception() SECURITY DEFINER Postgres function
 * which is the ONLY SQL path that can write reviewer_action. This Edge Function
 * is the ONLY caller of that Postgres function.
 *
 * Chain of custody:
 *   Human clicks approve/reject/escalate in ExceptionQueue.tsx
 *   → POST /functions/v1/safisha-resolve
 *   → safisha_resolve_exception() (SECURITY DEFINER, sets session variable)
 *   → trigger checks session variable → allows UPDATE
 *   → session variable revoked immediately
 *   → audit log written atomically
 *
 * IRON DOME INVARIANTS:
 *   - reviewer_id comes from supabase.auth.getUser() — NOT from request body
 *     (prevents a caller from forging a reviewer identity)
 *   - action must be 'approved' | 'rejected' | 'escalated' — nothing else
 *   - After resolution, re-runs safisha-score to refresh confidence score
 *   - No auto-resolution: this function never fires without an explicit HTTP POST
 *     from a human UI action
 *
 * POST /functions/v1/safisha-resolve
 * Body: {
 *   exception_id:       string
 *   action:             'approved' | 'rejected' | 'escalated'
 *   note?:              string
 * }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_ACTIONS = new Set(["approved", "rejected", "escalated"]);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    // Auth — reviewer_id always from the authenticated session, never from request body
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { exception_id, action, note } = await req.json();

    // Validate inputs
    if (!exception_id) {
      return new Response(JSON.stringify({ error: "exception_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!VALID_ACTIONS.has(action)) {
      return new Response(JSON.stringify({
        error: `Invalid action '${action}'. Must be: approved | rejected | escalated`,
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Verify exception exists and belongs to this user's reconciliation
    const { data: exc, error: excErr } = await supabase
      .from("safisha_exceptions")
      .select("id,reconciliation_id,reviewer_action,category")
      .eq("id", exception_id)
      .single();

    if (excErr || !exc) {
      return new Response(JSON.stringify({ error: "Exception not found or access denied" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (exc.reviewer_action !== "pending") {
      return new Response(JSON.stringify({
        error: `Exception is already resolved (status: ${exc.reviewer_action}). Resolved exceptions are immutable.`,
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── The single gatekeeper call ────────────────────────────────────────────
    // This calls the SECURITY DEFINER Postgres function which is the only
    // SQL path that can write reviewer_action.

    const { data: resolveResult, error: resolveErr } = await supabase.rpc(
      "safisha_resolve_exception",
      {
        p_exception_id: exception_id,
        p_reviewer_id:  user.id,   // always the authenticated user
        p_action:       action,
        p_note:         note ?? null,
      }
    );

    if (resolveErr) {
      // Postgres will raise an exception with our Iron Dome message if anything
      // violates the guard. Surface that message directly.
      return new Response(JSON.stringify({
        error: resolveErr.message,
        iron_dome: true, // signals to the UI this is a guard violation, not a network error
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Re-score after resolution ─────────────────────────────────────────────
    // Call safisha-score internally to refresh confidence score
    const reconId = exc.reconciliation_id;
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/safisha-score`,
        {
          method:  "POST",
          headers: {
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
            "Content-Type":  "application/json",
          },
          body: JSON.stringify({ reconciliation_id: reconId }),
        }
      );
    } catch {
      // Non-fatal — UI can re-score on next load
    }

    return new Response(JSON.stringify({
      success:           true,
      exception_id,
      action,
      reviewer_id:       user.id,
      reconciliation_id: reconId,
      recon_status:      resolveResult?.recon_status,
      remaining_pending: resolveResult?.remaining,
      message:           actionMessage(action, exc.category, resolveResult?.recon_status),
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("safisha-resolve error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function actionMessage(action: string, category: string, reconStatus: string): string {
  if (reconStatus === "clean") {
    return "All exceptions resolved. Trial balance is clean — tax engine is now unlocked.";
  }
  if (reconStatus === "blocked") {
    return "A rejected 'investigate' exception has blocked this reconciliation. The tax engine cannot run until the issue is corrected.";
  }
  const verb = action === "approved"  ? "approved"
             : action === "rejected"  ? "rejected"
             : "escalated for senior review";
  return `Exception ${verb}. ${resolveResult_remaining_text(action, category)}`;
}

function resolveResult_remaining_text(action: string, category: string): string {
  if (action === "rejected" && category === "investigate") {
    return "Rejected investigate exceptions block the reconciliation — all must be approved or escalated to clear.";
  }
  return "Continue reviewing remaining pending exceptions.";
}
