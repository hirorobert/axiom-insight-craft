/**
 * maono-root-cause · IRON DOME NUCLEAR DESIGN · Phase B
 *
 * Claude API agent — explains WHY material variances happened.
 *
 * IRON DOME — AI NUMERIC ENFORCEMENT (Fix 4b, validated):
 *   1. Claude is invoked with tools=[get_variance_data]. It MUST call this tool
 *      to retrieve figures. Raw numbers are NOT in the prompt.
 *   2. Tool handler returns the actual DB rows to Claude.
 *   3. Post-generation validator extracts all numeric tokens (≥1,000 TZS)
 *      from Claude's response and verifies each appears in the tool-call result.
 *   4. If validation fails: retry once with explicit citation instruction.
 *   5. If retry fails: store with confidence_level='validation_failed'.
 *      Validation-failed insights are hidden from CFO/Director views.
 *
 * IRON DOME — TANZANIA CONTEXT:
 *   Context is loaded from maono_context table — NOT from Claude's training data.
 *   When TRA rules change, update maono_context — not the prompt template.
 *
 * POST /functions/v1/maono-root-cause
 * Body: { run_id: string }
 */

import { serve }       from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic        from "https://esm.sh/@anthropic-ai/sdk@0.27.3";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Tool definition ───────────────────────────────────────────────────────────
// Claude MUST call this to get variance figures. Numbers are never in the prompt.

const VARIANCE_TOOL = {
  name:        "get_variance_data",
  description: "Retrieve the variance analysis data for this run. " +
               "You MUST call this tool before discussing any figures. " +
               "Do not state any TZS amount you did not receive from this tool.",
  input_schema: {
    type:       "object" as const,
    properties: {
      run_id: {
        type:        "string",
        description: "The variance run ID",
      },
      categories: {
        type:  "array",
        items: { type: "string" },
        description: "Optional: filter to specific P&L categories (e.g. ['REVENUE', 'COST_OF_SALES'])",
      },
      material_only: {
        type:        "boolean",
        description: "If true, return only accounts with is_material=true",
      },
    },
    required: ["run_id"],
  },
};

// ── Numeric validation ────────────────────────────────────────────────────────
// Iron Dome Fix 4b: every number ≥1000 in AI output must exist in snapshot data

function extractNumericTokens(text: string): number[] {
  const tokens: number[] = [];
  const matches = text.match(/[\d,]+(?:\.\d+)?/g) ?? [];
  for (const m of matches) {
    const v = parseFloat(m.replace(/,/g, ""));
    if (!isNaN(v) && v >= 1000) tokens.push(v);
  }
  return [...new Set(tokens)];
}

function validateNumbers(aiText: string, snapshotNumbers: number[]): {
  passed: boolean;
  checked: number;
  failed: number[];
} {
  const tokens   = extractNumericTokens(aiText);
  const failed: number[] = [];

  for (const t of tokens) {
    // Allow ±0.1% rounding tolerance (formatted numbers may be rounded)
    const found = snapshotNumbers.some(n =>
      n === 0 ? t === 0 : Math.abs(Math.abs(n) - t) / Math.max(Math.abs(n), t, 1) < 0.001
    );
    if (!found) failed.push(t);
  }

  return { passed: failed.length === 0, checked: tokens.length, failed };
}

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(contextBlocks: string[], seasonalNote: string): string {
  return `You are a senior financial analyst specialising in Tanzanian corporate finance.
Your task is to explain WHY material budget variances occurred in clear, direct language.

MANDATORY RULES — IRON DOME ENFORCEMENT:
1. You MUST call the get_variance_data tool BEFORE stating any financial figure.
2. Every TZS amount you mention must come directly from the tool response. Do not compute or estimate new figures.
3. Do not mention account codes in your explanation — use account names and P&L categories only.
4. Be specific about causes. "Revenue was below budget" is not analysis. "Revenue was TZS X below budget, likely because Y" is analysis.
5. For each material variance, consider Tanzania-specific factors (statutory costs, seasonal patterns, FX impact, TRA compliance costs).
6. Write in plain English. Your audience includes non-accountants.

FORMAT for each material variance:
**[P&L Category] — [Account Name]**
Variance: [amount from tool] ([direction] vs budget)
Root cause assessment: [2-4 sentences explaining WHY, citing Tanzania context where relevant]
Confidence: [High/Medium/Low — based on available data]

TANZANIA CONTEXT (use this — do NOT rely on training data for Tanzania regulations):
${contextBlocks.join("\n\n")}

${seasonalNote}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { run_id } = await req.json();
    if (!run_id) return json({ error: "run_id is required" }, 400);

    // Load run + confidence
    const { data: run } = await supabase
      .from("variance_runs")
      .select("id, company_id, period_from, period_to, trend_confidence, seasonal_periods_available, status")
      .eq("id", run_id)
      .single();
    if (!run) return json({ error: "Run not found" }, 404);
    if (run.status !== "complete") return json({ error: "Run must be complete first" }, 409);

    // Load Tanzania context from DB (not from training data)
    const { data: ctxRows } = await supabase
      .from("maono_context")
      .select("context_key, title, content, context_version")
      .eq("is_active", true)
      .order("context_key");

    const contextBlocks  = (ctxRows ?? []).map((c: any) => `## ${c.title}\n${c.content}`);
    const ctxVersion     = (ctxRows ?? []).map((c: any) => c.context_version).reduce((a, b) => a + b, 0);

    const seasonalNote   = run.seasonal_periods_available < 2
      ? "NOTE: This company has fewer than 2 years of historical data. " +
        "Seasonal pattern analysis is not available. Mark all trend-based assessments as Low confidence."
      : `This company has ${run.seasonal_periods_available} years of comparable data for this period.`;

    // Load material variances (input_snapshot for Iron Dome validation)
    const { data: analyses } = await supabase
      .from("variance_analyses")
      .select("account_code, account_name, pl_category, actual_amount, budget_amount, variance_tzs, variance_pct")
      .eq("run_id", run_id)
      .eq("is_material", true)
      .not("pl_category", "in", '("BALANCE_SHEET_ASSET","BALANCE_SHEET_LIAB","BALANCE_SHEET_EQUITY","STATISTICAL")')
      .order("variance_tzs", { ascending: true });

    if (!analyses || analyses.length === 0) {
      return json({
        success:   true,
        run_id,
        message:   "No material variances to analyse. Run is on-plan.",
        insights:  [],
      }, 200);
    }

    // Collect all snapshot numbers for validation
    const snapshotNumbers: number[] = [];
    for (const a of analyses) {
      if (a.actual_amount != null) snapshotNumbers.push(a.actual_amount);
      if (a.budget_amount != null) snapshotNumbers.push(a.budget_amount);
      if (a.variance_tzs != null)  snapshotNumbers.push(a.variance_tzs);
    }

    const inputSnapshot = { analyses };

    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
    });

    // ── Agentic Claude invocation with tool-use ───────────────────────────────

    async function runWithToolUse(retryWithCitation = false): Promise<{ text: string; toolCallResult: any }> {
      const userMessage = retryWithCitation
        ? `Analyse the material variances for run ${run_id}. ` +
          "IMPORTANT: After every TZS figure you cite, include [source: from tool data]. " +
          "Do not state any number you did not receive from the get_variance_data tool."
        : `Analyse the material variances for run ${run_id}. ` +
          "Call get_variance_data first, then explain each material variance in plain English with Tanzania context.";

      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: userMessage }
      ];

      let finalText = "";
      let toolCallResult: any = null;
      let continueLoop = true;

      while (continueLoop) {
        const response = await anthropic.messages.create({
          model:      "claude-sonnet-4-6",
          max_tokens: 4096,
          system:     buildSystemPrompt(contextBlocks, seasonalNote),
          tools:      [VARIANCE_TOOL as any],
          messages,
        });

        // Process response
        for (const block of response.content) {
          if (block.type === "text") {
            finalText += block.text;
          }

          if (block.type === "tool_use" && block.name === "get_variance_data") {
            const input = block.input as { run_id: string; material_only?: boolean; categories?: string[] };

            // Execute the tool — return DB rows
            let rows = analyses;
            if (input.categories?.length) {
              rows = rows.filter((a: any) => input.categories!.includes(a.pl_category));
            }
            if (input.material_only) {
              rows = rows.filter((a: any) => a.is_material);
            }

            toolCallResult = {
              run_id:    run_id,
              period:    `${run.period_from} to ${run.period_to}`,
              accounts:  rows.map((a: any) => ({
                account_code:  a.account_code,
                account_name:  a.account_name,
                pl_category:   a.pl_category,
                actual_tzs:    a.actual_amount,
                budget_tzs:    a.budget_amount,
                variance_tzs:  a.variance_tzs,
                variance_pct:  a.variance_pct ? Math.round(a.variance_pct * 10) / 10 : null,
                direction:     (a.variance_tzs ?? 0) > 0 ? "favourable" : "adverse",
              })),
              period_note: seasonalNote,
            };

            // Add tool result to messages and continue
            messages.push({ role: "assistant", content: response.content });
            messages.push({
              role: "user",
              content: [{
                type:        "tool_result" as const,
                tool_use_id: block.id,
                content:     JSON.stringify(toolCallResult),
              }],
            });
          }
        }

        continueLoop = response.stop_reason === "tool_use";
        if (response.stop_reason === "end_turn") continueLoop = false;
      }

      return { text: finalText, toolCallResult };
    }

    // First attempt
    let { text, toolCallResult } = await runWithToolUse(false);
    let validation = validateNumbers(text, snapshotNumbers);

    // Retry if validation failed
    let isRetry = false;
    if (!validation.passed && toolCallResult) {
      isRetry = true;
      const retry = await runWithToolUse(true);
      text       = retry.text;
      validation = validateNumbers(retry.text, snapshotNumbers);
    }

    const confidenceLevel: string =
      !validation.passed          ? "validation_failed"
      : run.seasonal_periods_available >= 8 ? "high"
      : run.seasonal_periods_available >= 4 ? "medium"
      : run.seasonal_periods_available >= 2 ? "low"
      : "none";

    // Store insight (append-only)
    const { data: insight, error: insErr } = await supabase
      .from("maono_insights")
      .insert({
        run_id,
        company_id:                run.company_id,
        insight_type:              "root_cause",
        subject_account_codes:     analyses.map((a: any) => a.account_code),
        subject_pl_categories:     [...new Set(analyses.map((a: any) => a.pl_category))],
        input_snapshot:            inputSnapshot,
        ai_output:                 text,
        ai_model_used:             "claude-sonnet-4-6",
        confidence_level:          confidenceLevel,
        numeric_validation_passed: validation.passed,
        numeric_validation_detail: {
          checked: validation.checked,
          failed:  validation.failed,
          retried: isRetry,
        },
        context_version:           ctxVersion,
      })
      .select("id")
      .single();

    if (insErr) throw new Error("Insert maono_insights failed: " + insErr.message);

    return json({
      success:                   true,
      run_id,
      insight_id:                insight?.id,
      confidence_level:          confidenceLevel,
      numeric_validation_passed: validation.passed,
      validation_detail:         { checked: validation.checked, failed_count: validation.failed.length, retried: isRetry },
      material_variances_analysed: analyses.length,
      next_step:                 "Call maono-risk → maono-decide",
    }, 200);

  } catch (err: any) {
    console.error("maono-root-cause error:", err);
    return json({ error: err.message }, 500);
  }
});

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
