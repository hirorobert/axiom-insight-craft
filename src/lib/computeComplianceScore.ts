/**
 * computeComplianceScore.ts
 * Phase 1-A — Iron Dome Nuclear Design: Eliminate computation divergence
 *
 * THE canonical compliance scoring engine.
 * This is the ONLY place where compliance scores are computed.
 * ComplianceScorecard and FirmDashboardPanel both import from here.
 * No other file may re-implement or inline this formula.
 *
 * Architecture:
 *   scoreFromData(input)           — pure function, no DB, fully testable
 *   fetchScoringData(companyId)    — single-company DB fetcher
 *   fetchScoringDataBatch(ids[])   — batch DB fetcher (O(5) queries, not O(N×5))
 *
 * Score factors (verified 2026-07-11):
 *   A. Open findings × severity weight          30 pts  (ITA Cap.332 compliance)
 *   B. Transfer pricing / thin cap risk         20 pts  (ITA s.33 + s.24A)
 *   C. Payment coverage vs exposure             20 pts  (TAA 2015 penalty prevention)
 *   D. Overdue filing obligations               15 pts  (TAA 2015 s.76)
 *   E. Period sign-off / lock status            15 pts  (Iron Dome period close)
 *   ─────────────────────────────────────────  100 pts
 *
 * Grade thresholds (fixed — do not change without re-verifying all consumers):
 *   ≥90 = Compliant  |  ≥70 = Monitor  |  ≥50 = At Risk  |  <50 = Critical
 */

import { supabase } from "@/integrations/supabase/client";

// ── Types ─────────────────────────────────────────────────────────────────────

/** High-severity finding categories under ITA Cap.332 */
const HIGH_SEVERITY_CATEGORIES = [
  "cit_underpayment",
  "penalty",
  "minimum_tax_gap",
  "management_fee_disallowance",
] as const;

/** TP-related finding categories */
const TP_CATEGORIES = [
  "management_fee_disallowance",
  "thin_cap_disallowance",
  "transfer_pricing",
] as const;

export type ComplianceGrade = "Compliant" | "Monitor" | "At Risk" | "Critical";

export interface ScoreFactor {
  label: string;
  score: number;       // 0–100 for this factor
  weight: number;      // 0.0–1.0
  contribution: number; // score × weight → points earned
  maxPts: number;
  detail: string;
  status: "good" | "warn" | "bad";
}

export interface ComplianceScore {
  totalScore: number;
  grade: ComplianceGrade;
  factors: ScoreFactor[];
}

/**
 * All data the scoring function needs.
 * DB fetchers populate this; the pure function consumes it.
 */
export interface ScoringInputData {
  /** All open + in_progress findings for this company */
  openFindings: Array<{
    finding_category: string;
    exposure_amount_tzs: number;
    period_end: string | null;
  }>;
  /** classification_warnings from the latest tax_computations.computation_detail */
  taxCompWarnings: Array<{ category?: string }>;
  /** Sum of tax_payments.amount_paid_tzs for this company */
  totalPaid: number;
  /** Latest statement_sign_offs.status, or null if none exists */
  signOffStatus: string | null;
  /** Reference time for overdue calculation — pass new Date() or a fixed date for tests */
  now: Date;
}

// ── Pure scoring function ─────────────────────────────────────────────────────

/** Convert total score to grade. Single source of truth. */
export function scoreToGrade(score: number): ComplianceGrade {
  if (score >= 90) return "Compliant";
  if (score >= 70) return "Monitor";
  if (score >= 50) return "At Risk";
  return "Critical";
}

/** Clamp a score to [0, 100]. */
function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Compute a compliance score from pre-fetched data.
 * Pure function — no DB calls, no side effects, deterministic.
 * Test this directly with vitest.
 */
export function scoreFromData(input: ScoringInputData): ComplianceScore {
  const { openFindings, taxCompWarnings, totalPaid, signOffStatus, now } = input;

  // ── Factor A: Open findings (30 pts) ─────────────────────────────────────
  const totalExposure = openFindings.reduce((s, f) => s + f.exposure_amount_tzs, 0);
  const highCount = openFindings.filter(f =>
    HIGH_SEVERITY_CATEGORIES.includes(f.finding_category as typeof HIGH_SEVERITY_CATEGORIES[number])
  ).length;
  const lowCount = openFindings.length - highCount;

  const findingDeduction = Math.min(100, highCount * 15 + lowCount * 8);
  const scoreA = clamp(100 - findingDeduction);
  const factorA: ScoreFactor = {
    label: "Open Findings",
    score: scoreA,
    weight: 0.30,
    contribution: scoreA * 0.30,
    maxPts: 30,
    detail: openFindings.length === 0
      ? "No open compliance findings"
      : `${openFindings.length} open finding${openFindings.length > 1 ? "s" : ""} (${highCount} high-severity) — TZS ${totalExposure.toLocaleString("en-TZ", { maximumFractionDigits: 0 })} exposure`,
    status: scoreA >= 80 ? "good" : scoreA >= 50 ? "warn" : "bad",
  };

  // ── Factor B: Transfer pricing / thin cap risk (20 pts) ──────────────────
  const tpFindings = openFindings.filter(f =>
    TP_CATEGORIES.includes(f.finding_category as typeof TP_CATEGORIES[number])
  );
  const tpExposure = tpFindings.reduce((s, f) => s + f.exposure_amount_tzs, 0);
  const tpWarnings = taxCompWarnings.filter(w =>
    ["management_fee", "thin_cap", "transfer_pricing"].includes(w?.category ?? "")
  ).length;

  const scoreB = tpFindings.length === 0 && tpWarnings === 0
    ? 100
    : clamp(100 - tpFindings.length * 25 - tpWarnings * 10);
  const factorB: ScoreFactor = {
    label: "Transfer Pricing Risk",
    score: scoreB,
    weight: 0.20,
    contribution: scoreB * 0.20,
    maxPts: 20,
    detail: tpFindings.length === 0 && tpWarnings === 0
      ? "No TP risk detected (ITA s.33 + s.24A)"
      : `${tpFindings.length} TP finding${tpFindings.length !== 1 ? "s" : ""}, ${tpWarnings} warning${tpWarnings !== 1 ? "s" : ""} — TZS ${tpExposure.toLocaleString("en-TZ", { maximumFractionDigits: 0 })} exposure`,
    status: scoreB >= 90 ? "good" : scoreB >= 60 ? "warn" : "bad",
  };

  // ── Factor C: Payment coverage vs exposure (20 pts) ──────────────────────
  let scoreC: number;
  let paymentDetail: string;
  if (totalExposure <= 0) {
    scoreC = 100;
    paymentDetail = "No outstanding exposure — no payment required";
  } else {
    const coverageRatio = totalPaid / totalExposure;
    scoreC = clamp(coverageRatio * 100);
    paymentDetail = `TZS ${totalPaid.toLocaleString("en-TZ", { maximumFractionDigits: 0 })} paid vs TZS ${totalExposure.toLocaleString("en-TZ", { maximumFractionDigits: 0 })} exposure (${Math.round(coverageRatio * 100)}% coverage)`;
  }
  const factorC: ScoreFactor = {
    label: "Payment Coverage",
    score: scoreC,
    weight: 0.20,
    contribution: scoreC * 0.20,
    maxPts: 20,
    detail: paymentDetail,
    status: scoreC >= 80 ? "good" : scoreC >= 50 ? "warn" : "bad",
  };

  // ── Factor D: Overdue filing obligations (15 pts) ─────────────────────────
  const overdueCount = openFindings.filter(f => {
    if (!f.period_end) return false;
    const due = new Date(f.period_end);
    due.setDate(due.getDate() + 30); // 30-day grace period
    return due < now;
  }).length;

  const scoreD = clamp(100 - overdueCount * 20);
  const factorD: ScoreFactor = {
    label: "Filing Deadlines",
    score: scoreD,
    weight: 0.15,
    contribution: scoreD * 0.15,
    maxPts: 15,
    detail: overdueCount === 0
      ? "All filing deadlines on track"
      : `${overdueCount} obligation${overdueCount > 1 ? "s" : ""} past the 30-day grace period`,
    status: scoreD >= 80 ? "good" : scoreD >= 50 ? "warn" : "bad",
  };

  // ── Factor E: Period sign-off status (15 pts) ─────────────────────────────
  const SIGN_OFF_SCORES: Record<string, number> = {
    locked:          100,
    approved:         90,
    reviewer_signed:  70,
    preparer_signed:  50,
    draft:            30,
  };
  const SIGN_OFF_DETAILS: Record<string, string> = {
    locked:          "Period locked — statements approved and immutable",
    approved:        "Approver signed — awaiting lock",
    reviewer_signed: "Reviewer signed — awaiting approver",
    preparer_signed: "Preparer signed — awaiting reviewer",
    draft:           "Sign-off in draft — no signatures yet",
  };

  const scoreE = signOffStatus ? (SIGN_OFF_SCORES[signOffStatus] ?? 30) : 40;
  const signOffDetail = signOffStatus
    ? (SIGN_OFF_DETAILS[signOffStatus] ?? `Status: ${signOffStatus}`)
    : "No sign-off record — statements not yet reviewed";

  const factorE: ScoreFactor = {
    label: "Period Sign-off",
    score: scoreE,
    weight: 0.15,
    contribution: scoreE * 0.15,
    maxPts: 15,
    detail: signOffDetail,
    status: scoreE >= 80 ? "good" : scoreE >= 50 ? "warn" : "bad",
  };

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const totalScore = Math.round(
    factorA.contribution +
    factorB.contribution +
    factorC.contribution +
    factorD.contribution +
    factorE.contribution
  );

  return {
    totalScore,
    grade: scoreToGrade(totalScore),
    factors: [factorA, factorB, factorC, factorD, factorE],
  };
}

// ── DB fetchers ───────────────────────────────────────────────────────────────

/**
 * Fetch scoring data for a single company.
 * Use this in ComplianceScorecard (per-company expand pattern).
 */
export async function fetchScoringData(companyId: string): Promise<ScoringInputData> {
  const [
    { data: findings },
    { data: taxComps },
    { data: payments },
    { data: signOffs },
  ] = await Promise.all([
    supabase
      .from("findings")
      .select("finding_category, exposure_amount_tzs, period_end")
      .eq("company_id", companyId)
      .in("status", ["open", "in_progress"]),

    supabase
      .from("tax_computations")
      .select("computation_detail")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1),

    supabase
      .from("tax_payments")
      .select("amount_paid_tzs")           // authoritative column name
      .eq("company_id", companyId),

    supabase
      .from("statement_sign_offs")
      .select("status")
      .eq("company_id", companyId)
      .order("period_year", { ascending: false })
      .limit(1),
  ]);

  const lastResult = (taxComps?.[0]?.computation_detail as any) ?? null;
  const taxCompWarnings: Array<{ category?: string }> =
    lastResult?.classification_warnings ?? [];

  return {
    openFindings: (findings ?? []).map(f => ({
      finding_category: f.finding_category,
      exposure_amount_tzs: Number(f.exposure_amount_tzs ?? 0),
      period_end: f.period_end ?? null,
    })),
    taxCompWarnings,
    totalPaid: (payments ?? []).reduce((s, p) => s + Number(p.amount_paid_tzs ?? 0), 0),
    signOffStatus: signOffs?.[0]?.status ?? null,
    now: new Date(),
  };
}

/**
 * Fetch scoring data for multiple companies in O(4) queries (not O(N×4)).
 * Use this in FirmDashboardPanel and any other batch-scoring consumer.
 * Returns a Map<companyId, ScoringInputData>.
 */
export async function fetchScoringDataBatch(
  companyIds: string[]
): Promise<Map<string, ScoringInputData>> {
  if (companyIds.length === 0) return new Map();

  const now = new Date();

  const [
    { data: findings },
    { data: taxComps },
    { data: payments },
    { data: signOffs },
  ] = await Promise.all([
    supabase
      .from("findings")
      .select("company_id, finding_category, exposure_amount_tzs, period_end")
      .in("company_id", companyIds)
      .in("status", ["open", "in_progress"]),

    supabase
      .from("tax_computations")
      .select("company_id, computation_detail, created_at")
      .in("company_id", companyIds)
      .order("created_at", { ascending: false }),

    supabase
      .from("tax_payments")
      .select("company_id, amount_paid_tzs")   // authoritative column name
      .in("company_id", companyIds),

    supabase
      .from("statement_sign_offs")
      .select("company_id, status, period_year")
      .in("company_id", companyIds)
      .order("period_year", { ascending: false }),
  ]);

  // Build per-company maps — latest-wins for tax_computations and sign_offs
  const taxCompMap = new Map<string, Array<{ category?: string }>>();
  for (const tc of (taxComps ?? [])) {
    if (!taxCompMap.has(tc.company_id)) {
      const warnings = (tc.computation_detail as any)?.classification_warnings ?? [];
      taxCompMap.set(tc.company_id, warnings);
    }
  }

  const paidMap = new Map<string, number>();
  for (const p of (payments ?? [])) {
    paidMap.set(p.company_id, (paidMap.get(p.company_id) ?? 0) + Number(p.amount_paid_tzs ?? 0));
  }

  const signOffMap = new Map<string, string | null>();
  for (const s of (signOffs ?? [])) {
    if (!signOffMap.has(s.company_id)) signOffMap.set(s.company_id, s.status);
  }

  const findingsMap = new Map<string, ScoringInputData["openFindings"]>();
  for (const f of (findings ?? [])) {
    const arr = findingsMap.get(f.company_id) ?? [];
    arr.push({
      finding_category: f.finding_category,
      exposure_amount_tzs: Number(f.exposure_amount_tzs ?? 0),
      period_end: f.period_end ?? null,
    });
    findingsMap.set(f.company_id, arr);
  }

  const result = new Map<string, ScoringInputData>();
  for (const id of companyIds) {
    result.set(id, {
      openFindings:     findingsMap.get(id) ?? [],
      taxCompWarnings:  taxCompMap.get(id)  ?? [],
      totalPaid:        paidMap.get(id)     ?? 0,
      signOffStatus:    signOffMap.get(id)  ?? null,
      now,
    });
  }
  return result;
<<<<<<< HEAD
}
=======
}
>>>>>>> 331bb78 (fix(platform): enforce member identity, EFDMS controls, and statutory gating)
