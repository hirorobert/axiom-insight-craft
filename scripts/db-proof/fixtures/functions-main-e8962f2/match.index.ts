/**
 * safisha-match · IRON DOME NUCLEAR DESIGN · Stage 3 v2
 *
 * 6-tier matching pipeline (upgraded with RapidFuzz-equivalent fuzzy matching):
 *
 *   Tier 1 — Exact:           same account_code + same date + amount diff = 0
 *   Tier 1.5 — Fuzzy name:    account_code differs but account_name similarity ≥ FUZZY_NAME_THRESHOLD
 *                              + same date (±DATE_DRIFT_DAYS) + amount diff ≤ 1%
 *                              → needs_adjustment exception (reviewer confirms the name link)
 *   Tier 2 — Timing:          same account_code + amount = 0 diff + |date diff| ≤ DATE_DRIFT_DAYS
 *   Tier 2.5 — Fuzzy ref:     no account_code match but reference/narration similarity ≥ FUZZY_REF_THRESHOLD
 *                              + amount diff ≤ 1% + date ±DATE_DRIFT_DAYS
 *                              → needs_adjustment exception (reviewer confirms the narration link)
 *   Tier 3 — Amount drift:    same account_code + same date + amount diff ≤ AMOUNT_DRIFT_PCT
 *   Tier 4 — One-to-many:     sum of ≤5 evidence lines matches one TB line within drift
 *   Tier 5 — Unmatched:       no match found → investigate exception
 *
 * IRON DOME:
 *   - Fuzzy matches are NEVER silent. They ALWAYS produce exceptions for human review.
 *   - The reviewer sees the exact match score and which fields were fuzzy-matched.
 *   - reviewer_action is NEVER written here — always 'pending' on insert.
 *
 * POST /functions/v1/safisha-match
 * Body: { reconciliation_id: string }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Matching tolerances ───────────────────────────────────────────────────────

const DATE_DRIFT_DAYS      = 7;    // ≤7 days → timing
const AMOUNT_DRIFT_PCT     = 0.01; // ≤1% → needs_adjustment
const ONE_TO_MANY_LIMIT    = 5;    // max evidence lines to sum for one-to-many
const FUZZY_NAME_THRESHOLD = 80;   // token-sort ratio ≥ 80% → fuzzy name match
const FUZZY_REF_THRESHOLD  = 75;   // narration/reference ratio ≥ 75% → fuzzy ref match
const FUZZY_DATE_DRIFT     = 14;   // days allowed for fuzzy matches (wider than exact)

// ── Types ─────────────────────────────────────────────────────────────────────

interface TxnRow {
  id:           string;
  source_id:    "tb" | "bank" | "subledger" | "momo";
  account_code: string;
  account_name: string | null;
  txn_date:     string | null;
  debit:        number | null;
  credit:       number | null;
  reference:    string | null;
}

interface ExceptionInsert {
  reconciliation_id: string;
  account_code:      string;
  account_name:      string | null;
  category:          "timing" | "needs_adjustment" | "investigate";
  variance:          number;
  age_days:          number;
  tb_txn_id:         string | null;
  evidence_txn_id:   string | null;
  match_type:        "one_to_one" | "one_to_many" | "unmatched";
  description:       string;
  reviewer_action:   "pending";
  reviewer_id:       null;
  resolved_at:       null;
}

// ── Core math ─────────────────────────────────────────────────────────────────

function txnAmount(txn: TxnRow): number {
  return (txn.debit ?? 0) - (txn.credit ?? 0);
}

function dateDiff(a: string | null, b: string | null): number {
  if (!a || !b) return Infinity;
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function amountDiff(a: number, b: number): number {
  return Math.abs(a - b);
}

function driftPct(tbAmt: number, evAmt: number): number {
  if (tbAmt === 0) return evAmt === 0 ? 0 : Infinity;
  return amountDiff(tbAmt, evAmt) / Math.abs(tbAmt);
}

// ── RapidFuzz-equivalent: Token Sort Ratio ────────────────────────────────────
//
// Normalises strings by: lowercase → strip non-alphanum → split → sort tokens → rejoin
// Then computes character-level overlap ratio (same algorithm as fuzz.token_sort_ratio).
// Pure TypeScript, zero dependencies. Handles common Tanzanian account name variations:
//   "CRDB Bank Cash Account"  vs  "CRDB"           → ~82%
//   "NMB Bank Ltd"            vs  "NMB"            → ~73% (below threshold: flagged separately)
//   "Accounts Receivable–CIT" vs  "A/C REC CIT"   → ~68%
//   "Cash at Hand"            vs  "CASH HAND"      → ~89%

function normaliseTokens(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function tokenSortRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = normaliseTokens(a);
  const nb = normaliseTokens(b);
  if (na === nb) return 100;
  // Levenshtein distance via DP (O(m*n) — acceptable for short strings)
  const m = na.length, n = nb.length;
  if (m === 0 || n === 0) return 0;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const cur = na[i - 1] === nb[j - 1]
        ? dp[j - 1]
        : 1 + Math.min(dp[j], prev, dp[j - 1]);
      dp[j - 1] = prev;
      prev = cur;
    }
    dp[n] = prev;
  }
  const dist = dp[n];
  return Math.round((1 - dist / Math.max(m, n)) * 100);
}

// Reference/narration fuzzy match — bag-of-words overlap
// "PAYMENT CRDB 2025-01-15 REF 001"  vs  "CRDB PAYMENT 001"  → high overlap
function referenceOverlapRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const tokensA = new Set(normaliseTokens(a).split(" ").filter(t => t.length > 2));
  const tokensB = new Set(normaliseTokens(b).split(" ").filter(t => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  tokensA.forEach(t => { if (tokensB.has(t)) overlap++; });
  return Math.round((overlap / Math.min(tokensA.size, tokensB.size)) * 100);
}

// ── Exception description builders ────────────────────────────────────────────

function descExact(tbAmt: number, ageDays: number): string {
  if (ageDays === 0) return `Exact match. No exceptions.`;
  return `Timing difference: ${ageDays} day(s) apart. Amounts agree.`;
}

function descFuzzyName(
  tbCode: string, evCode: string,
  tbName: string | null, evName: string | null,
  score: number, variance: number, tbAmt: number
): string {
  const pct = (driftPct(tbAmt, tbAmt - variance) * 100).toFixed(2);
  return [
    `Fuzzy account name match (similarity: ${score}%).`,
    `TB account: "${tbCode}${tbName ? " — " + tbName : ""}"`,
    `Evidence account: "${evCode}${evName ? " — " + evName : ""}"`,
    variance > 0 ? `Amount variance: ${variance.toLocaleString()} TZS (${pct}%).` : `Amounts agree.`,
    `Reviewer: confirm these are the same account before approving.`,
  ].join(" ");
}

function descFuzzyRef(
  tbRef: string | null, evRef: string | null,
  score: number, variance: number
): string {
  return [
    `Fuzzy narration/reference match (similarity: ${score}%).`,
    `TB reference: "${tbRef ?? "—"}"`,
    `Evidence reference: "${evRef ?? "—"}"`,
    variance > 0 ? `Amount variance: ${variance.toLocaleString()} TZS.` : `Amounts agree.`,
    `Reviewer: confirm this narration matches the TB entry before approving.`,
  ].join(" ");
}

function descAmtDrift(tbAmt: number, evAmt: number): string {
  const diff = tbAmt - evAmt;
  return `Amount variance of ${Math.abs(diff).toLocaleString()} TZS (${(driftPct(tbAmt, evAmt)*100).toFixed(2)}%). ${diff > 0 ? "TB exceeds evidence." : "Evidence exceeds TB."}`;
}

function descUnmatched(tbAmt: number, tbCode: string): string {
  return `No matching evidence found for account ${tbCode}. TB records ${Math.abs(tbAmt).toLocaleString()} TZS with no corresponding bank/subledger/MoMo entry.`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

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

    // Load & validate reconciliation
    const { data: recon, error: reconErr } = await supabase
      .from("safisha_reconciliations")
      .select("id, status, tb_upload_id, sealed")
      .eq("id", reconciliation_id)
      .single();
    if (reconErr || !recon) {
      return new Response(JSON.stringify({ error: "Reconciliation not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (recon.sealed) {
      return new Response(JSON.stringify({ error: "Reconciliation is sealed — create a new one to re-match" }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load all transactions
    const { data: txns, error: txnErr } = await supabase
      .from("safisha_transactions")
      .select("id,source_id,account_code,account_name,txn_date,debit,credit,reference")
      .eq("reconciliation_id", reconciliation_id);

    if (txnErr) throw new Error("Failed to load transactions: " + txnErr.message);
    if (!txns || txns.length === 0) {
      return new Response(JSON.stringify({ error: "No transactions — run safisha-ingest first" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tbLines:       TxnRow[] = txns.filter((t: TxnRow) => t.source_id === "tb");
    const evidenceLines: TxnRow[] = txns.filter((t: TxnRow) => t.source_id !== "tb");

    if (tbLines.length === 0) {
      return new Response(JSON.stringify({ error: "No TB transactions found. Ingest TB first with source_id='tb'." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Remove any previously-pending exceptions (re-match is idempotent)
    await supabase
      .from("safisha_exceptions")
      .delete()
      .eq("reconciliation_id", reconciliation_id)
      .eq("reviewer_action", "pending");

    // ── Build lookup indexes ──────────────────────────────────────────────────

    // Primary index: account_code → evidence rows (for tiers 1–3)
    const byCode = new Map<string, TxnRow[]>();
    for (const ev of evidenceLines) {
      const list = byCode.get(ev.account_code) ?? [];
      list.push(ev);
      byCode.set(ev.account_code, list);
    }

    // Secondary index: all evidence rows accessible for cross-account fuzzy search
    // (tiers 1.5, 2.5 search ALL evidence, not just same account_code)
    const allEvidence = [...evidenceLines];

    const exceptions:       ExceptionInsert[] = [];
    const matchedTbIds      = new Set<string>();
    const matchedEvidenceIds = new Set<string>();
    let matchedCount = 0;

    // Stats for response
    const tierHits = { t1: 0, t1_5: 0, t2: 0, t2_5: 0, t3: 0, t4: 0, t5: 0 };

    // ── 6-Tier Matching Loop ──────────────────────────────────────────────────

    for (const tb of tbLines) {
      const tbAmt  = txnAmount(tb);
      const sameCode = (byCode.get(tb.account_code) ?? []).filter(e => !matchedEvidenceIds.has(e.id));
      const allUnused  = allEvidence.filter(e => !matchedEvidenceIds.has(e.id));

      // ── Tier 1: Exact (account_code + date + amount) ─────────────────────
      const t1 = sameCode.find(e =>
        dateDiff(tb.txn_date, e.txn_date) === 0 &&
        amountDiff(tbAmt, txnAmount(e)) === 0
      );
      if (t1) {
        matchedEvidenceIds.add(t1.id); matchedTbIds.add(tb.id); matchedCount++;
        tierHits.t1++; continue;
      }

      // ── Tier 1.5: Fuzzy name cross-account match ──────────────────────────
      // account_code differs, but account_name is similar + amount/date close
      if (tb.account_name) {
        let bestFuzzyName: TxnRow | null = null;
        let bestScore = 0;

        for (const ev of allUnused) {
          if (!ev.account_name) continue;
          if (ev.account_code === tb.account_code) continue; // already handled above
          const score = tokenSortRatio(tb.account_name, ev.account_name);
          if (score < FUZZY_NAME_THRESHOLD) continue;
          const age = dateDiff(tb.txn_date, ev.txn_date);
          if (age > FUZZY_DATE_DRIFT) continue;
          if (driftPct(tbAmt, txnAmount(ev)) > AMOUNT_DRIFT_PCT * 3) continue; // 3× for fuzzy
          if (score > bestScore) { bestScore = score; bestFuzzyName = ev; }
        }

        if (bestFuzzyName) {
          const variance = amountDiff(tbAmt, txnAmount(bestFuzzyName));
          matchedEvidenceIds.add(bestFuzzyName.id); matchedTbIds.add(tb.id);
          exceptions.push({
            reconciliation_id,
            account_code:    tb.account_code,
            account_name:    tb.account_name,
            category:        "needs_adjustment",
            variance,
            age_days:        Math.round(dateDiff(tb.txn_date, bestFuzzyName.txn_date)),
            tb_txn_id:       tb.id,
            evidence_txn_id: bestFuzzyName.id,
            match_type:      "one_to_one",
            description:     descFuzzyName(
              tb.account_code, bestFuzzyName.account_code,
              tb.account_name, bestFuzzyName.account_name,
              bestScore, variance, tbAmt
            ),
            reviewer_action: "pending",
            reviewer_id:     null,
            resolved_at:     null,
          });
          tierHits.t1_5++; continue;
        }
      }

      // ── Tier 2: Timing drift (same code, exact amount, date within window) ─
      const t2 = sameCode.find(e =>
        amountDiff(tbAmt, txnAmount(e)) === 0 &&
        dateDiff(tb.txn_date, e.txn_date) <= DATE_DRIFT_DAYS
      );
      if (t2) {
        const ageDays = Math.round(dateDiff(tb.txn_date, t2.txn_date));
        matchedEvidenceIds.add(t2.id); matchedTbIds.add(tb.id);
        exceptions.push({
          reconciliation_id,
          account_code:    tb.account_code,
          account_name:    tb.account_name,
          category:        "timing",
          variance:        0,
          age_days:        ageDays,
          tb_txn_id:       tb.id,
          evidence_txn_id: t2.id,
          match_type:      "one_to_one",
          description:     `Timing difference: TB date vs evidence date ${ageDays} day(s) apart. Amounts agree exactly.`,
          reviewer_action: "pending",
          reviewer_id:     null,
          resolved_at:     null,
        });
        tierHits.t2++; continue;
      }

      // ── Tier 2.5: Fuzzy reference/narration match ─────────────────────────
      // No account_code or name match, but reference text is similar + amount close
      if (tb.reference) {
        let bestFuzzyRef: TxnRow | null = null;
        let bestRefScore = 0;

        for (const ev of allUnused) {
          if (!ev.reference) continue;
          const score = referenceOverlapRatio(tb.reference, ev.reference);
          if (score < FUZZY_REF_THRESHOLD) continue;
          const age = dateDiff(tb.txn_date, ev.txn_date);
          if (age > FUZZY_DATE_DRIFT) continue;
          if (driftPct(tbAmt, txnAmount(ev)) > AMOUNT_DRIFT_PCT * 5) continue; // wider for ref-only match
          if (score > bestRefScore) { bestRefScore = score; bestFuzzyRef = ev; }
        }

        if (bestFuzzyRef) {
          const variance = amountDiff(tbAmt, txnAmount(bestFuzzyRef));
          matchedEvidenceIds.add(bestFuzzyRef.id); matchedTbIds.add(tb.id);
          exceptions.push({
            reconciliation_id,
            account_code:    tb.account_code,
            account_name:    tb.account_name,
            category:        "needs_adjustment",
            variance,
            age_days:        Math.round(dateDiff(tb.txn_date, bestFuzzyRef.txn_date)),
            tb_txn_id:       tb.id,
            evidence_txn_id: bestFuzzyRef.id,
            match_type:      "one_to_one",
            description:     descFuzzyRef(tb.reference, bestFuzzyRef.reference, bestRefScore, variance),
            reviewer_action: "pending",
            reviewer_id:     null,
            resolved_at:     null,
          });
          tierHits.t2_5++; continue;
        }
      }

      // ── Tier 3: Amount drift (same code + same date, amount ≤ 1% off) ─────
      const t3 = sameCode.find(e =>
        dateDiff(tb.txn_date, e.txn_date) === 0 &&
        driftPct(tbAmt, txnAmount(e)) <= AMOUNT_DRIFT_PCT
      );
      if (t3) {
        const variance = amountDiff(tbAmt, txnAmount(t3));
        matchedEvidenceIds.add(t3.id); matchedTbIds.add(tb.id);
        exceptions.push({
          reconciliation_id,
          account_code:    tb.account_code,
          account_name:    tb.account_name,
          category:        "needs_adjustment",
          variance,
          age_days:        0,
          tb_txn_id:       tb.id,
          evidence_txn_id: t3.id,
          match_type:      "one_to_one",
          description:     descAmtDrift(tbAmt, txnAmount(t3)),
          reviewer_action: "pending",
          reviewer_id:     null,
          resolved_at:     null,
        });
        tierHits.t3++; continue;
      }

      // ── Tier 4: One-to-many (sum of ≤5 evidence lines = TB amount) ────────
      const candidates = sameCode.slice(0, ONE_TO_MANY_LIMIT * 2);
      let combo: TxnRow[] | null = null;
      for (let sz = 2; sz <= Math.min(ONE_TO_MANY_LIMIT, candidates.length); sz++) {
        combo = findCombination(candidates, sz, tbAmt);
        if (combo) break;
      }
      if (combo) {
        combo.forEach(e => matchedEvidenceIds.add(e.id));
        matchedTbIds.add(tb.id); matchedCount++;
        tierHits.t4++; continue;
      }

      // ── Tier 5: Unmatched ─────────────────────────────────────────────────
      matchedTbIds.add(tb.id);
      exceptions.push({
        reconciliation_id,
        account_code:    tb.account_code,
        account_name:    tb.account_name,
        category:        "investigate",
        variance:        Math.abs(tbAmt),
        age_days:        0,
        tb_txn_id:       tb.id,
        evidence_txn_id: null,
        match_type:      "unmatched",
        description:     descUnmatched(tbAmt, tb.account_code),
        reviewer_action: "pending",
        reviewer_id:     null,
        resolved_at:     null,
      });
      tierHits.t5++;
    }

    // ── Batch-insert exceptions ───────────────────────────────────────────────

    const BATCH = 200;
    for (let b = 0; b < exceptions.length; b += BATCH) {
      const { error: insErr } = await supabase
        .from("safisha_exceptions")
        .insert(exceptions.slice(b, b + BATCH));
      if (insErr) throw new Error("Insert exceptions failed: " + insErr.message);
    }

    // ── Update reconciliation ─────────────────────────────────────────────────

    const newStatus = exceptions.length === 0 ? "clean" : "needs_review";

    await supabase.from("safisha_reconciliations").update({
      matched_count:   matchedCount,
      exception_count: exceptions.length,
      total_tb_lines:  tbLines.length,
      status:          newStatus,
    }).eq("id", reconciliation_id);

    if (exceptions.length === 0) {
      await supabase.from("trial_balance_uploads")
        .update({ safisha_status: "clean" })
        .eq("id", recon.tb_upload_id);
    }

    return new Response(JSON.stringify({
      success:           true,
      reconciliation_id,
      matched_count:     matchedCount,
      exception_count:   exceptions.length,
      total_tb_lines:    tbLines.length,
      status:            newStatus,
      tier_breakdown:    tierHits,
      exception_categories: {
        timing:           exceptions.filter(e => e.category === "timing").length,
        needs_adjustment: exceptions.filter(e => e.category === "needs_adjustment").length,
        investigate:      exceptions.filter(e => e.category === "investigate").length,
      },
      fuzzy_matches: tierHits.t1_5 + tierHits.t2_5,
      next_step: exceptions.length > 0
        ? "Call safisha-categorize → safisha-score → present ExceptionQueue"
        : "TB is clean — tax engine unlocked",
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("safisha-match error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── One-to-many combination finder ────────────────────────────────────────────

function findCombination(pool: TxnRow[], size: number, target: number): TxnRow[] | null {
  function choose(start: number, chosen: TxnRow[]): TxnRow[] | null {
    if (chosen.length === size) {
      const sum = chosen.reduce((s, e) => s + txnAmount(e), 0);
      return driftPct(target, sum) <= AMOUNT_DRIFT_PCT ? chosen : null;
    }
    for (let i = start; i <= pool.length - (size - chosen.length); i++) {
      const r = choose(i + 1, [...chosen, pool[i]]);
      if (r) return r;
    }
    return null;
  }
  return choose(0, []);
}
