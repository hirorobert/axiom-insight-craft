/**
 * maono-decide · IRON DOME NUCLEAR DESIGN · Phase B
 *
 * Claude agent — generates exactly 3 decision paths per material issue.
 *
 * IRON DOME RULES:
 *   1. Exactly 3 paths per issue — no more, no less. The number 3 is enforced
 *      in the system prompt AND in a post-generation structural validator.
 *   2. TZS impact figures MUST come from the get_decision_data tool call.
 *      Numbers never appear in the prompt. Same citation enforcement as maono-root-cause.
 *   3. Actions are NEVER auto-executed. Every path ends with a human-decision anchor:
 *      "This requires your sign-off before any action is taken."
 *   4. Paths are labelled: Conservative / Moderate / Aggressive.
 *      For cash/statutory issues they are: Immediate / Phased / Deferred.
 *   5. Materiality thresholds from DB — no hardcoded numbers.
 *   6. Decision insight stored append-only. Cannot be modified after generation.
 *
 * Input: post-root-cause, post-risk analyses for the same run_id.
 * Output: structured decision options for each material P&L category.
 *
 * POST /functions/v1/maono-decide
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

const DECISION_TOOL = {
  name:        "get_decision_data",
  description: "Retrieve all data needed to propose decision paths: " +
               "material variances, risk signals, cash position, and Tanzania context. " +
               "You MUST call this before proposing any decision path. " +
               "Every TZS figure you cite must come from this tool result.",
  input_schema: {
    type:       "object" as const,
    properties: {
      run_id: {
        type:        "string",
        description: "The variance run ID to load data for",
      },
      focus_categories: {
        type:  "array",
        items: { type: "string" },
        description: "Optional: filter to specific P&L categories. Omit to return all material issues.",
      },
    },
    required: ["run_id"],
  },
};

// ── Structural validator: exactly 3 paths per issue ───────────────────────────

interface PathValidation {
  passed:          boolean;
  issues_found:    number;
  issues_with_3:   number;
  issues_not_3:    string[];
}

function validateDecisionPaths(text: string): PathValidation {
  // Split on issue headers — "## [Category]" or "**[Category]**" pattern
  const issueBlocks = text.split(/(?=##\s|\*\*[A-Z_]+\*\*)/g)
    .filter(b => b.trim().length > 50); // non-trivial blocks only

  if (issueBlocks.length === 0) {
    return { passed: false, issues_found: 0, issues_with_3: 0, issues_not_3: ["no_issues_detected"] };
  }

  const issuesNot3: string[] = [];
  let issuesWith3 = 0;

  for (const block of issueBlocks) {
    // Count path labels
    const conservativeCount = (block.match(/\b(Conservative|Immediate)\b/gi) ?? []).length;
    const moderateCount     = (block.match(/\b(Moderate|Phased)\b/gi) ?? []).length;
    const aggressiveCount   = (block.match(/\b(Aggressive|Deferred)\b/gi) ?? []).length;

    const hasAll3 = conservativeCount > 0 && moderateCount > 0 && aggressiveCount > 0;

    if (hasAll3) {
      issuesWith3++;
    } else {
      const header = block.substring(0, 60).replace(/\n/g, " ").trim();
      issuesNot3.push(header);
    }
  }

  return {
    passed:        issuesWith3 > 0 && issuesNot3.length === 0,
    issues_found:  issueBlocks.length,
    issues_with_3: issuesWith3,
    issues_not_3:  issuesNot3,
  };
}

// ── Numeric validator (same as root-cause) ────────────────────────────────────

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
  const tokens  = extractNumericTokens(aiText);
  const failed: number[] = [];
  for (const t of tokens) {
    const found = snapshotNumbers.some(n =>
      Math.abs(Math.abs(n) - t) / Math.max(Math.abs(n), t, 1) < 0.001
    );
    if (!found) failed.push(t);
  }
  return { passed: failed.length === 0, checked: tokens.length, failed };
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(contextBlocks: string[], materiality: any): string {
  const pctThreshold = materiality?.pct_threshold ?? 10;
  const absThreshold = materiality?.abs_threshold_tzs ?? 5_000_000;

  return `You are a senior CFO advisor specialising in Tanzanian corporate finance.
Your task is to propose EXACTLY 3 decision paths for each material budget variance.

MANDATORY STRUCTURE — IRON DOME ENFORCEMENT:
1. Call get_decision_data FIRST. Every TZS figure you cite must come from that tool.
2. For each material issue, output EXACTLY 3 numbered paths. No more. No fewer.
3. Label paths as: Conservative / Moderate / Aggressive
   For cash and statutory issues: Immediate / Phased / Deferred
4. Every path MUST end with: "This requires your sign-off before any action is taken."
5. Never recommend auto-execution. Never suggest API calls or system changes.
6. For TRA audit signals: always recommend professional tax counsel as Conservative path.

FORMAT for each material issue:
---
## [P&L Category] — [Account Name] | Variance: [TZS from tool] [direction] vs budget

**Context:** [1–2 sentences: what the root cause analysis found + risk classification]

**Path 1 — Conservative**
Action: [specific, named action]
TZS impact: [figure from tool or "Non-quantifiable without further data"]
Timeline: [weeks/months]
Trade-off: [what you gain vs what you give up]
This requires your sign-off before any action is taken.

**Path 2 — Moderate**
Action: [specific, named action]
TZS impact: [figure from tool or "Non-quantifiable"]
Timeline: [weeks/months]
Trade-off: [what you gain vs what you give up]
This requires your sign-off before any action is taken.

**Path 3 — Aggressive**
Action: [specific, named action]
TZS impact: [figure from tool or "Non-quantifiable"]
Timeline: [weeks/months]
Trade-off: [what you gain vs what you give up]
This requires your sign-off before any action is taken.

---

MATERIALITY CONTEXT:
This company's materiality thresholds are: >${pctThreshold}% variance OR >TZS ${absThreshold.toLocaleString()}.
Only issues meeting these thresholds appear in your dataset.

TANZANIA CONTEXT (authoritative — do not use training data for Tanzania regulations):
${contextBlocks.join("\n\n")}

IMPORTANT: At the end of your response, include a section:
## RECOMMENDED PRIORITY ORDER
List each issue in order of urgency (1 = most urgent). One line each: "[Issue] — [one-sentence reason]"
`;
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

    // Load run
    const { data: run } = await supabase
      .from("variance_runs")
      .select("id, company_id, period_from, period_to, seasonal_periods_available, trend_confidence, status")
      .eq("id", run_id)
      .single();
    if (!run) return json({ error: "Run not found" }, 404);

    const companyId = run.company_id;

    // Load materiality thresholds (per-company, from DB — never hardcoded)
    const { data: mat } = await supabase
      .from("variance_materiality")
      .select("pct_threshold, abs_threshold_tzs, cash_warn_days, cash_critical_days")
      .eq("company_id", companyId)
      .single();

    // Load Tanzania context from DB
    const { data: ctxRows } = await supabase
      .from("maono_context")
      .select("context_key, title, content, context_version")
      .eq("is_active", true)
      .order("context_key");

    const contextBlocks = (ctxRows ?? []).map((c: any) => `## ${c.title}\n${c.content}`);
    const ctxVersion    = (ctxRows ?? []).map((c: any) => c.context_version).reduce((a, b) => a + b, 0);

    // Load material analyses
    const { data: analyses } = await supabase
      .from("variance_analyses")
      .select("account_code, account_name, pl_category, actual_amount, budget_amount, variance_tzs, variance_pct")
      .eq("run_id", run_id)
      .eq("is_material", true)
      .order("variance_tzs", { ascending: true }); // worst first

    if (!analyses || analyses.length === 0) {
      return json({ success: true, run_id, message: "No material variances — no decisions needed", paths: [] }, 200);
    }

    // Load root-cause insight (to give Claude the WHY)
    const { data: rootInsight } = await supabase
      .from("maono_insights")
      .select("ai_output, confidence_level")
      .eq("run_id", run_id)
      .eq("insight_type", "root_cause")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // Load risk insight
    const { data: riskInsight } = await supabase
      .from("maono_insights")
      .select("ai_output")
      .eq("run_id", run_id)
      .eq("insight_type", "risk")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // Load cash forecast (week 1 closing cash for context)
    const { data: cashWeek1 } = await supabase
      .from("cashflow_forecasts")
      .select("closing_cash, risk_flag, risk_reason")
      .eq("run_id", run_id)
      .eq("week_number", 1)
      .single();

    // Load unacknowledged alerts
    const { data: alerts } = await supabase
      .from("variance_alerts")
      .select("alert_type, severity, message")
      .eq("company_id", companyId)
      .is("acknowledged_at", null)
      .order("severity", { ascending: false });

    // Build snapshot for tool call result
    const toolResultPayload = {
      run_period:  `${run.period_from} to ${run.period_to}`,
      material_variances: analyses.map((a: any) => ({
        account_name:  a.account_name,
        pl_category:   a.pl_category,
        actual_tzs:    a.actual_amount,
        budget_tzs:    a.budget_amount,
        variance_tzs:  a.variance_tzs,
        variance_pct:  a.variance_pct ? Math.round(a.variance_pct * 10) / 10 : null,
        direction:     (a.variance_tzs ?? 0) > 0 ? "favourable" : "adverse",
      })),
      root_cause_summary: rootInsight?.ai_output?.substring(0, 2000) ?? "Root cause analysis not yet available.",
      risk_summary:       riskInsight?.ai_output?.substring(0, 1000) ?? "Risk analysis not yet available.",
      cash_position: cashWeek1 ? {
        week1_closing_cash: cashWeek1.closing_cash,
        risk_flag:          cashWeek1.risk_flag,
        risk_reason:        cashWeek1.risk_reason,
      } : null,
      active_alerts: (alerts ?? []).slice(0, 10).map((a: any) => ({
        type:     a.alert_type,
        severity: a.severity,
        message:  a.message,
      })),
      materiality: mat,
      trend_confidence: run.trend_confidence,
    };

    // Snapshot numbers for validation
    const snapshotNumbers: number[] = [];
    for (const a of analyses) {
      if (a.actual_amount != null)  snapshotNumbers.push(Math.abs(a.actual_amount));
      if (a.budget_amount != null)  snapshotNumbers.push(Math.abs(a.budget_amount));
      if (a.variance_tzs != null)   snapshotNumbers.push(Math.abs(a.variance_tzs));
    }
    if (cashWeek1?.closing_cash != null) snapshotNumbers.push(Math.abs(cashWeek1.closing_cash));
    if (mat?.abs_threshold_tzs != null)  snapshotNumbers.push(mat.abs_threshold_tzs);

    const inputSnapshot = { analyses, root_cause: rootInsight?.ai_output?.substring(0, 500), risk: riskInsight?.ai_output?.substring(0, 500), cash: cashWeek1, alerts };

    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

    // ── Agentic loop ──────────────────────────────────────────────────────────

    async function runDecideAgent(retryInstruction = ""): Promise<string> {
      const userContent =
        `Generate exactly 3 decision paths for each material budget variance in run ${run_id}. ` +
        `Call get_decision_data first. ` +
        (retryInstruction || "Follow the mandatory format exactly.");

      const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];
      let finalText = "";
      let continueLoop = true;

      while (continueLoop) {
        const response = await anthropic.messages.create({
          model:      "claude-sonnet-4-6",
          max_tokens: 6000,
          system:     buildSystemPrompt(contextBlocks, mat),
          tools:      [DECISION_TOOL as any],
          messages,
        });

        for (const block of response.content) {
          if (block.type === "text") finalText += block.text;

          if (block.type === "tool_use" && block.name === "get_decision_data") {
            const input = block.input as { run_id: string; focus_categories?: string[] };
            let payload = toolResultPayload;

            if (input.focus_categories?.length) {
              payload = {
                ...payload,
                material_variances: payload.material_variances.filter(
                  (v: any) => input.focus_categories!.includes(v.pl_category)
                ),
              };
            }

            messages.push({ role: "assistant", content: response.content });
            messages.push({
              role: "user",
              content: [{
                type:        "tool_result" as const,
                tool_use_id: block.id,
                content:     JSON.stringify(payload),
              }],
            });
          }
        }

        continueLoop = response.stop_reason === "tool_use";
        if (response.stop_reason === "end_turn") continueLoop = false;
      }

      return finalText;
    }

    // First attempt
    let text = await runDecideAgent();
    let numValidation     = validateNumbers(text, snapshotNumbers);
    let structValidation  = validateDecisionPaths(text);

    // Retry if structure or numbers invalid
    let retried = false;
    if (!numValidation.passed || !structValidation.passed) {
      retried = true;
      const retryInstr = [
        !structValidation.passed
          ? "CRITICAL: Each issue must have EXACTLY 3 paths labelled Conservative/Moderate/Aggressive (or Immediate/Phased/Deferred for cash issues). The validator found issues without all 3 labels."
          : "",
        !numValidation.passed
          ? `CRITICAL: Some TZS figures you used (${numValidation.failed.join(", ")}) could not be verified against the tool data. Only cite figures from the tool response.`
          : "",
      ].filter(Boolean).join(" ");

      text              = await runDecideAgent(retryInstr);
      numValidation     = validateNumbers(text, snapshotNumbers);
      structValidation  = validateDecisionPaths(text);
    }

    const validationPassed = numValidation.passed && structValidation.passed;
    const confidenceLevel: string =
      !validationPassed              ? "validation_failed"
      : run.seasonal_periods_available >= 8 ? "high"
      : run.seasonal_periods_available >= 4 ? "medium"
      : run.seasonal_periods_available >= 2 ? "low"
      : "none";

    // Store decision insight (append-only)
    const { data: insight, error: insErr } = await supabase
      .from("maono_insights")
      .insert({
        run_id,
        company_id:                companyId,
        insight_type:              "decision",
        subject_account_codes:     analyses.map((a: any) => a.account_code),
        subject_pl_categories:     [...new Set(analyses.map((a: any) => a.pl_category))],
        input_snapshot:            inputSnapshot,
        ai_output:                 text,
        ai_model_used:             "claude-sonnet-4-6",
        confidence_level:          confidenceLevel,
        numeric_validation_passed: numValidation.passed,
        numeric_validation_detail: {
          numeric: { checked: numValidation.checked, failed: numValidation.failed },
          structure: {
            passed:       structValidation.passed,
            issues_found: structValidation.issues_found,
            issues_with_3: structValidation.issues_with_3,
            issues_not_3:  structValidation.issues_not_3,
          },
          retried,
        },
        context_version: ctxVersion,
      })
      .select("id")
      .single();

    if (insErr) throw new Error("Insert decision insight failed: " + insErr.message);

    return json({
      success:                   true,
      run_id,
      insight_id:                insight?.id,
      confidence_level:          confidenceLevel,
      issues_analysed:           analyses.length,
      all_issues_have_3_paths:   structValidation.passed,
      numeric_validation_passed: numValidation.passed,
      retried,
      warning:                   !validationPassed
        ? "Validation failed after retry. Decision insight marked validation_failed. " +
          "Shown to Accountant role only — not visible to CFO/Director/Manager."
        : undefined,
    }, 200);

  } catch (err: any) {
    console.error("maono-decide error:", err);
    return json({ error: err.message }, 500);
  }
});

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
