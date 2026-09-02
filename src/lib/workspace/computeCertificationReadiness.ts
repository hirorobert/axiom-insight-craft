/**
 * computeCertificationReadiness — six-layer SAFISHA readiness, sourced from
 * the AUTHORITATIVE tb_certifications ledger (Slice 4B), not the mutable
 * trial_balance_uploads.processing_result projection computePreflight.ts
 * reads. Pure projection. No writes, no inference: a layer with no recorded
 * evidence is "pending" (NOT_COMPUTED), never silently "passed".
 *
 * Layer semantics are grounded in the exact `layer` values process-trial-
 * balance/index.ts actually assigns (SafishaExceptionRecord), not invented:
 *   L1 — file read/structured. Never itself an exception: a certification
 *        row can only exist after the file parsed, so its mere presence is
 *        the evidence for this layer.
 *   L2 — data quality (malformed numeric / parse-level errors).
 *   L3 — arithmetic integrity (TB imbalance AND statement/balance-sheet
 *        equation — both use layer 3 in the source of truth).
 *   L4 — classification completeness (NEEDS_REVIEW / unresolved accounts).
 *   L5 — supporting evidence (generic bank/subledger reconciliation signal,
 *        Slice 4A). Informational only — never drives is_blocking/
 *        requires_review.
 *   L6 — prior-period signal (Slice 4A). Informational only, same as L5.
 *
 * Iron Dome: NULL means NOT COMPUTED. A fetch failure must never collapse
 * into "pending" (which means "nothing to report yet") or "certified" — it
 * gets its own "unknown" verdict so the UI never fabricates an answer.
 */

import type {
  PreflightCheck,
  PreflightCheckState,
  PreflightResult,
  PreflightVerdict,
} from "./computePreflight";

export interface TbCertificationExceptionRecord {
  code: string;
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  severity: "error" | "warning" | "info";
  accountCode: string | null;
  message: string;
}

export interface TbCertificationRow {
  id: string;
  sequence_no: number;
  company_id: string;
  upload_id: string;
  period_year: number | null;
  is_blocking: boolean;
  requires_review: boolean;
  exceptions: TbCertificationExceptionRecord[];
  certified_at: string;
}

export interface CertificationReadinessInput {
  /** False before any trial balance has ever been uploaded for this workspace/period. */
  uploadExists: boolean;
  /**
   * get_authoritative_certification(company_id, period_year) result.
   * Present ONLY when a certification is both eligible (not blocking, not
   * requires_review) AND current (its source_file_hash still matches the
   * upload's live source_file_hash, or no drift signal is available).
   */
  authoritative: TbCertificationRow | null;
  /**
   * Latest tb_certifications row committed for the CURRENT upload,
   * regardless of eligibility. Null if no certification was ever committed
   * for this upload. Used only to explain why `authoritative` is empty —
   * never treated as authoritative on its own.
   */
  latestForUpload: TbCertificationRow | null;
  /** True if either read failed. Must win over every other field. */
  fetchFailed?: boolean;
}

const LAYER_META: Record<1 | 2 | 3 | 4 | 5 | 6, { id: string; label: string }> = {
  1: { id: "l1_structure", label: "File read and structured" },
  2: { id: "l2_data_quality", label: "Data quality" },
  3: { id: "l3_arithmetic", label: "Arithmetic integrity" },
  4: { id: "l4_classification", label: "Classification completeness" },
  5: { id: "l5_supporting_evidence", label: "Supporting evidence" },
  6: { id: "l6_prior_period", label: "Prior-period signal" },
};

const PASSED_DETAIL: Record<2 | 3 | 4, string> = {
  2: "No data-quality errors raised.",
  3: "The trial balance and statement equation both hold.",
  4: "All accounts are classified.",
};

function buildLayerChecks(row: TbCertificationRow | null): PreflightCheck[] {
  return ([1, 2, 3, 4, 5, 6] as const).map((layer) => {
    const meta = LAYER_META[layer];

    if (!row) {
      return { id: meta.id, label: meta.label, state: "pending", detail: "Not checked yet." };
    }

    if (layer === 1) {
      // Never itself an exception source — a committed row is proof enough.
      return {
        id: meta.id,
        label: meta.label,
        state: "passed",
        detail: "Every row in the file was read and totalled.",
      };
    }

    const entries = row.exceptions.filter((e) => e.layer === layer);

    if (entries.length === 0) {
      if (layer === 5 || layer === 6) {
        // Certifications committed before Slice 4A shipped this evidence
        // genuinely have nothing here — that is NOT_COMPUTED, not "clean".
        return { id: meta.id, label: meta.label, state: "pending", detail: "Not available for this certification." };
      }
      return { id: meta.id, label: meta.label, state: "passed", detail: PASSED_DETAIL[layer] };
    }

    const hasError = entries.some((e) => e.severity === "error");
    const hasWarning = entries.some((e) => e.severity === "warning");
    const state: PreflightCheckState = hasError ? "failed" : hasWarning ? "review" : "passed";
    return { id: meta.id, label: meta.label, state, detail: entries.map((e) => e.message).join(" ") };
  });
}

function countPassed(checks: PreflightCheck[]): number {
  return checks.filter((c) => c.state === "passed").length;
}

export function computeCertificationReadiness(input: CertificationReadinessInput): PreflightResult {
  if (!input.uploadExists) {
    return {
      verdict: "pending",
      headline: "No trial balance imported yet",
      blocker: "Import a trial balance to start the pre-flight check.",
      checks: [],
      passedCount: 0,
      totalCount: 0,
    };
  }

  if (input.fetchFailed) {
    const checks = buildLayerChecks(null);
    return {
      verdict: "unknown",
      headline: "Could not verify certification status",
      blocker: "A connection problem prevented reading the authoritative certification. Try again.",
      checks,
      passedCount: 0,
      totalCount: checks.length,
    };
  }

  if (input.authoritative) {
    const checks = buildLayerChecks(input.authoritative);
    return {
      verdict: "certified",
      headline: "Certified — safe to prepare statements",
      blocker: null,
      checks,
      passedCount: countPassed(checks),
      totalCount: checks.length,
    };
  }

  if (input.latestForUpload) {
    const row = input.latestForUpload;
    const checks = buildLayerChecks(row);
    const passedCount = countPassed(checks);

    if (row.is_blocking) {
      const failing = row.exceptions.find((e) => e.severity === "error");
      return {
        verdict: "blocked",
        headline: "Not certified — the trial balance does not hold",
        blocker: failing?.message ?? "This trial balance failed certification.",
        checks,
        passedCount,
        totalCount: checks.length,
      };
    }

    if (row.requires_review) {
      const reviewItem = row.exceptions.find((e) => e.layer === 4);
      return {
        verdict: "review",
        headline: "Needs your decision before statements",
        blocker: reviewItem?.message ?? "Some accounts still need a classification decision.",
        checks,
        passedCount,
        totalCount: checks.length,
      };
    }

    // Eligible at commit time (not blocking, not requires_review), yet the
    // authoritative RPC found nothing for the current upload: its recorded
    // source_file_hash no longer matches — the file changed since this
    // certification ran.
    return {
      verdict: "stale",
      headline: "Certification out of date — re-run required",
      blocker:
        'This trial balance has changed since it was last certified. Use "Replace trial balance" to re-certify the current file.',
      checks,
      passedCount,
      totalCount: checks.length,
    };
  }

  // Upload exists; no certification has ever been committed for it yet.
  const checks = buildLayerChecks(null);
  return {
    verdict: "pending",
    headline: "Pre-flight check running",
    blocker: "Statements open once this trial balance is certified.",
    checks,
    passedCount: 0,
    totalCount: checks.length,
  };
}

export type { PreflightResult, PreflightVerdict, PreflightCheck, PreflightCheckState };
