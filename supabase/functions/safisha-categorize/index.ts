/**
 * safisha-categorize · IRON DOME NUCLEAR DESIGN · Stage 4
 *
 * Refines exception categorization with business-rule reasoning and enriches
 * each exception's `description` field with a one-line reviewer explanation.
 *
 * safisha-match already assigns the initial category (timing/needs_adjustment/investigate).
 * This function applies additional rules on top:
 *
 *   TIMING  →  If age_days > 30, escalate to 'investigate' (stale timing difference)
 *   TIMING  →  If it's a closing-period item (posted after period-end grace), flag it
 *   NEEDS_ADJUSTMENT → If variance > TZS 10,000,000 (10M), escalate to 'investigate'
 *   INVESTIGATE → Always stays 'investigate'; enrich description with possible causes
 *
 * IRON DOME:
 *   - This function only updates the `description` field and may change `category`
 *     (timing → investigate) on pending exceptions.
 *   - It NEVER touches reviewer_action, reviewer_id, or resolved_at.
 *   - All re-categorizations are logged as updated description so the reviewer
 *     sees the reasoning.
 *
 * POST /functions/v1/safisha-categorize
 * Body: { reconciliation_id: string }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Thresholds (Iron Dome: these are pure business rules, no statutory rates)
const STALE_TIMING_DAYS       = 30;    // timing diff older than 30 days → investigate
const LARGE_ADJUSTMENT_TZS    = 10_000_000; // TZS 10M+ → investigate

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

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { reconciliation_id } = await req.json();
    if (!reconciliation_id) {
      return new Response(JSON.stringify({ error: "reconciliation_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load pending exceptions
    const { data: exceptions, error: excErr } = await supabase
      .from("safisha_exceptions")
      .select("id,category,variance,age_days,description,account_code,account_name")
      .eq("reconciliation_id", reconciliation_id)
      .eq("reviewer_action", "pending");

    if (excErr) throw new Error("Failed to load exceptions: " + excErr.message);
    if (!exceptions || exceptions.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: "No pending exceptions to categorize",
        updated: 0,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Apply categorization rules
    let escalated = 0;
    let enriched  = 0;

    for (const exc of exceptions) {
      let newCategory    = exc.category as string;
      let newDescription = exc.description as string;
      let changed        = false;

      // Rule 1: stale timing difference
      if (exc.category === "timing" && exc.age_days > STALE_TIMING_DAYS) {
        newCategory    = "investigate";
        newDescription = `Stale timing difference: ${exc.age_days} days between TB and evidence dates exceeds the ${STALE_TIMING_DAYS}-day tolerance. Original timing note: ${exc.description}`;
        escalated++;
        changed = true;
      }

      // Rule 2: large amount adjustment
      if (exc.category === "needs_adjustment" && exc.variance > LARGE_ADJUSTMENT_TZS) {
        newCategory    = "investigate";
        newDescription = `Large variance of TZS ${exc.variance.toLocaleString()} exceeds materiality threshold (TZS ${LARGE_ADJUSTMENT_TZS.toLocaleString()}). Requires investigation — this may indicate a booking error, duplicate, or unposted entry. Original note: ${exc.description}`;
        escalated++;
        changed = true;
      }

      // Rule 3: enrich 'investigate' description with possible causes
      if (!changed && exc.category === "investigate") {
        newDescription = enrichInvestigateDescription(exc.description, exc.variance, exc.account_code);
        enriched++;
        changed = true;
      }

      if (changed) {
        // Only updates description and category — never touches reviewer_action
        const { error: updErr } = await supabase
          .from("safisha_exceptions")
          .update({
            category:    newCategory,
            description: newDescription,
          })
          .eq("id", exc.id)
          .eq("reviewer_action", "pending"); // safety: never touch resolved ones

        if (updErr) throw new Error(`Failed to update exception ${exc.id}: ${updErr.message}`);
      }
    }

    // Re-count investigate exceptions after escalations
    const { count: investigateCount } = await supabase
      .from("safisha_exceptions")
      .select("id", { count: "exact", head: true })
      .eq("reconciliation_id", reconciliation_id)
      .eq("category", "investigate")
      .eq("reviewer_action", "pending");

    // If escalations bumped some timing → investigate, status stays needs_review
    if (escalated > 0) {
      await supabase.from("safisha_reconciliations").update({
        status: "needs_review",
      }).eq("id", reconciliation_id);
    }

    return new Response(JSON.stringify({
      success:          true,
      reconciliation_id,
      exceptions_total: exceptions.length,
      escalated_to_investigate: escalated,
      enriched,
      investigate_count: investigateCount ?? 0,
      next_step: "Call safisha-score to compute confidence scores",
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("safisha-categorize error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/**
 * Enrich 'investigate' descriptions with standard possible-cause text.
 * All text comes from business logic — no AI hallucination, no statutory numbers.
 */
function enrichInvestigateDescription(
  existing: string,
  variance: number,
  accountCode: string
): string {
  const causes: string[] = [];

  if (variance > 50_000_000) {
    causes.push("possible unposted journal entry or bank transfer");
    causes.push("check for timing of large payment/receipt not yet reflected in TB");
  } else if (variance > 5_000_000) {
    causes.push("possible duplicate or misclassified posting");
    causes.push("verify against bank confirmation or subledger detail");
  } else {
    causes.push("possible rounding or allocation difference");
    causes.push("cross-check narration/reference against TB memo field");
  }

  return `${existing} | Possible causes: ${causes.join("; ")}. Reviewer: confirm account ${accountCode} balance with source document.`;
}
