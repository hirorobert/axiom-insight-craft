/**
 * safisha-score · IRON DOME NUCLEAR DESIGN · Stage 4
 *
 * Computes a Confidence Score (0–100) per reconciliation account and at the
 * reconciliation level. Updates:
 *   - safisha_exceptions.confidence_score  (per-exception)
 *   - safisha_reconciliations.confidence_score (overall)
 *
 * CONFIDENCE SCORE FORMULA:
 *
 *   Per exception (0–100):
 *     timing:           80 − (age_days × 2)           clamped [0, 80]
 *     needs_adjustment: 60 − (variance_pct × 100)     clamped [0, 60]
 *     investigate:      0 until resolved by reviewer
 *
 *   Overall reconciliation (0–100):
 *     = (matched_count / total_tb_lines) × 100
 *       − penalty for each open 'investigate' exception (−10 each, max −40)
 *       − penalty for each open 'needs_adjustment' (−3 each, max −15)
 *       clamped [0, 100]
 *
 * A Confidence Score of 100 = TB perfectly matches all evidence.
 * A score of 0 = all TB lines unmatched or blocked.
 *
 * IRON DOME:
 *   - This function ONLY writes to confidence_score fields.
 *   - It never touches reviewer_action, category, or safisha_status.
 *   - Scores are re-computable at any time (idempotent).
 *
 * POST /functions/v1/safisha-score
 * Body: { reconciliation_id: string }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // Load reconciliation for match counts
    const { data: recon, error: reconErr } = await supabase
      .from("safisha_reconciliations")
      .select("id,matched_count,total_tb_lines,exception_count,status")
      .eq("id", reconciliation_id)
      .single();
    if (reconErr || !recon) throw new Error("Reconciliation not found");

    // Load all exceptions
    const { data: exceptions, error: excErr } = await supabase
      .from("safisha_exceptions")
      .select("id,category,variance,age_days,reviewer_action")
      .eq("reconciliation_id", reconciliation_id);
    if (excErr) throw new Error("Failed to load exceptions: " + excErr.message);

    const excs = exceptions ?? [];

    // ── Score each exception ──────────────────────────────────────────────────

    const updates: { id: string; confidence_score: number }[] = [];

    for (const exc of excs) {
      let score = 0;

      if (exc.reviewer_action !== "pending") {
        // Resolved exceptions get their final score based on outcome
        score = exc.reviewer_action === "approved"  ? 100
              : exc.reviewer_action === "rejected"  ? 0
              : /* escalated */                        30;
      } else {
        // Pending exceptions
        switch (exc.category) {
          case "timing":
            score = clamp(80 - (exc.age_days * 2), 0, 80);
            break;
          case "needs_adjustment": {
            // variance_pct not stored — approximate from variance alone
            // Use a stepped penalty: TZS <1M = low risk, <10M = medium, ≥10M = high
            const v = exc.variance;
            const penalty = v < 1_000_000   ? 10
                          : v < 5_000_000   ? 25
                          : v < 10_000_000  ? 40
                          : /* ≥10M */        60;
            score = clamp(60 - penalty, 0, 60);
            break;
          }
          case "investigate":
            score = 0; // Unresolved investigate exceptions contribute 0 confidence
            break;
        }
      }

      updates.push({ id: exc.id, confidence_score: score });
    }

    // Batch-update exception confidence scores (no trigger conflicts — only updates confidence_score)
    // We do individual updates because Supabase doesn't support batch UPDATE with different values per row
    for (const u of updates) {
      const { error: updErr } = await supabase
        .from("safisha_exceptions")
        .update({ confidence_score: u.confidence_score })
        .eq("id", u.id);
      if (updErr) throw new Error(`Failed to score exception ${u.id}: ${updErr.message}`);
    }

    // ── Overall reconciliation confidence score ───────────────────────────────

    const totalTB      = recon.total_tb_lines ?? 1; // guard against divide-by-zero
    const matchedCount = recon.matched_count ?? 0;

    // Base score from match rate
    let overallScore = totalTB > 0 ? (matchedCount / totalTB) * 100 : 0;

    // Penalty: open 'investigate' exceptions (−10 each, max −40)
    const openInvestigate = excs.filter(
      e => e.category === "investigate" && e.reviewer_action === "pending"
    ).length;
    overallScore -= Math.min(openInvestigate * 10, 40);

    // Penalty: open 'needs_adjustment' exceptions (−3 each, max −15)
    const openAdjustment = excs.filter(
      e => e.category === "needs_adjustment" && e.reviewer_action === "pending"
    ).length;
    overallScore -= Math.min(openAdjustment * 3, 15);

    // Penalty: open 'timing' exceptions (−1 each, max −5)
    const openTiming = excs.filter(
      e => e.category === "timing" && e.reviewer_action === "pending"
    ).length;
    overallScore -= Math.min(openTiming * 1, 5);

    overallScore = clamp(Math.round(overallScore), 0, 100);

    await supabase.from("safisha_reconciliations")
      .update({ confidence_score: overallScore })
      .eq("id", reconciliation_id);

    // Build explanation string
    const explanation = buildExplanation(
      matchedCount, totalTB, openInvestigate, openAdjustment, openTiming, overallScore
    );

    return new Response(JSON.stringify({
      success:           true,
      reconciliation_id,
      confidence_score:  overallScore,
      explanation,
      breakdown: {
        match_rate_pct:    totalTB > 0 ? Math.round((matchedCount / totalTB) * 100) : 0,
        open_investigate:  openInvestigate,
        open_adjustment:   openAdjustment,
        open_timing:       openTiming,
      },
      exceptions_scored: updates.length,
      next_step: overallScore < 80
        ? "Exceptions require reviewer action — open ExceptionQueue"
        : "Confidence score is acceptable — open ExceptionQueue to approve remaining items",
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("safisha-score error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function buildExplanation(
  matched: number,
  total: number,
  investigate: number,
  adjustment: number,
  timing: number,
  score: number
): string {
  const parts: string[] = [];
  parts.push(`${matched} of ${total} TB lines matched to evidence`);
  if (investigate > 0) parts.push(`${investigate} unmatched item(s) requiring investigation (−${Math.min(investigate*10,40)} pts)`);
  if (adjustment  > 0) parts.push(`${adjustment} amount variance(s) needing adjustment (−${Math.min(adjustment*3,15)} pts)`);
  if (timing      > 0) parts.push(`${timing} timing difference(s) (−${Math.min(timing,5)} pts)`);
  parts.push(`Overall confidence: ${score}/100`);
  return parts.join(". ") + ".";
}
