// Phase 5 prototype — LAYER 5: evidence sufficiency (isolated adapter).
//
// Reuses the production discipline (read-only facts):
//   - Evidence family (src/lib/financialEvidence/types.ts): every input other than the reviewed TB is an immutable,
//     versioned EVIDENCE BATCH with a validationStatus (VALID | VALID_WITH_WARNINGS | REQUIRES_REVIEW | INVALID).
//   - Readiness (fs_report_readiness / fs_publication_blockers): a report version is READY only when the blocker list is
//     empty. Blocker codes reused here: COMPARATIVE_PERIOD_MISSING, REQUIRED_EVIDENCE_MISSING:<type>,
//     CASHFLOW_LEDGER_AUTHORITY_UNRESOLVED, MAPPING_UNREVIEWED:<coverage>, EVIDENCE_NOT_VALID:<id>.
//   - Trust tier (maonoAnalyticalContract AnalyticalValue): KNOWN | MISSING | CANNOT_ASSESS — never a coerced zero, never a
//     plug. "Not every TB has enough info for complete statements": a missing input yields a GAP, never an invented figure.
//
// KEY SEPARATION: evidence sufficiency gates the OUTPUT, never the review. The TB review summary (the proposed Phase 6
// first slice) needs only a reviewed TB + recorded mapping review; complete statements need more, and the gaps are
// disclosed honestly rather than plugged.

/** Output-specific required evidence. This is the "output-specific evidence requirements" the DECISION records. */
export const OUTPUT_REQUIREMENTS = {
  tb_review_summary: ["TRIAL_BALANCE", "MAPPING_REVIEW"],
  complete_financial_statements: ["TRIAL_BALANCE", "MAPPING_REVIEW", "COMPARATIVE", "CASH_ACCOUNT_MAP", "TRANSACTION_LEDGER"],
};

const BLOCKER_FOR = {
  TRIAL_BALANCE: () => "REQUIRED_EVIDENCE_MISSING:TRIAL_BALANCE",
  MAPPING_REVIEW: (cov) => `MAPPING_UNREVIEWED:${cov}`,
  COMPARATIVE: () => "COMPARATIVE_PERIOD_MISSING",
  CASH_ACCOUNT_MAP: () => "CASHFLOW_LEDGER_AUTHORITY_UNRESOLVED",
  TRANSACTION_LEDGER: () => "REQUIRED_EVIDENCE_MISSING:TRANSACTION_LEDGER",
};

/** Trust-tier assessment of one evidence requirement against the available context. Never defaults a missing input. */
function assessRequirement(req, ctx) {
  if (req === "MAPPING_REVIEW") {
    const cov = ctx.mappingCoverage; // {total, unmapped, ambiguous}
    if (!cov) return { req, tier: "MISSING" };
    const complete = cov.unmapped === 0 && cov.ambiguous === 0 && cov.total > 0;
    return { req, tier: complete ? "KNOWN" : "CANNOT_ASSESS", coverage: `total=${cov.total};unmapped=${cov.unmapped};ambiguous=${cov.ambiguous}` };
  }
  const batch = (ctx.evidence || []).find((e) => e.type === req);
  if (!batch) return { req, tier: "MISSING" };
  if (batch.validationStatus === "INVALID" || batch.validationStatus === "REQUIRES_REVIEW") return { req, tier: "CANNOT_ASSESS", id: batch.evidenceBatchId };
  return { req, tier: "KNOWN", id: batch.evidenceBatchId };
}

/**
 * Assess an output's evidence sufficiency. Returns { output, ready, gaps, assessments }.
 * ready = every requirement KNOWN. gaps carry a production-shaped blocker code. Nothing is plugged.
 */
export function assessEvidence(output, ctx) {
  const reqs = OUTPUT_REQUIREMENTS[output];
  if (!reqs) throw new Error(`unknown output ${output}`);
  const assessments = reqs.map((r) => assessRequirement(r, ctx));
  const gaps = assessments.filter((a) => a.tier !== "KNOWN").map((a) => (a.req === "MAPPING_REVIEW" ? BLOCKER_FOR.MAPPING_REVIEW(a.coverage ?? "total=0;unmapped=0;ambiguous=0") : BLOCKER_FOR[a.req]()));
  return { output, ready: gaps.length === 0, gaps, assessments };
}
