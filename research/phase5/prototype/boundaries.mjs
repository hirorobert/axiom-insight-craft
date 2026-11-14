// Phase 5 prototype — ACCOUNTING BOUNDARIES (pure refusal helpers; exact BigInt money; nothing is invented or netted).
//
// These encode accounting disciplines as EXPLICIT refusals so the regression harness can prove the prototype will not
// fabricate authority it does not have. Where production already owns the discipline, the doc references the real authority:
//   - Adjustments are exact BALANCED journal layers over an immutable certification; the uploaded TB/certification never
//     change; an authority change makes dependent outputs "requires revalidation", never silently applied/discarded
//     (supabase/migrations/20261015100000_close_review_adjustments.sql).
//   - Currency + period are authoritative on fiscal_periods (reporting_currency FK, explicit dates), reached from an upload
//     via trial_balance_uploads.period_id (20260630100000 / 20261009100000). Two-period sourcing is real
//     (20261011100000_two_period_shared_source.sql).
import { toMinorUnits } from "./layer1_structure.mjs";

export class BoundaryRefusal extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }

// ── Prepayments: the three-component bridge. Net presentation needs opening + additions + release/amortisation, each
//    evidenced. Arithmetic agreement of a single closing figure does NOT authorise a net presentation. ──────────────────
export function prepaymentBridge({ opening, additions, release } = {}) {
  const have = { opening: opening != null, additions: additions != null, release: release != null };
  const missing = Object.entries(have).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new BoundaryRefusal("NET_PRESENTATION_REQUIRES_THREE_COMPONENT_BRIDGE", { missing });
  const o = toMinorUnits(opening), a = toMinorUnits(additions), r = toMinorUnits(release);
  return { opening: o, additions: a, release: r, closing: o + a - r, components_evidenced: true, net_presentation_authorised: true };
}
/** Only a closing figure is known. Even if it equals some arithmetic, net presentation is NOT authorised. */
export function assessNetFromClosingOnly() {
  return { net_presentation_authorised: false, code: "NET_PRESENTATION_REQUIRES_THREE_COMPONENT_BRIDGE",
    note: "A closing balance that agrees arithmetically does not authorise net presentation — the opening/additions/release bridge must each be evidenced." };
}

// ── Two trial balances establish a NET MOVEMENT only — never gross additions, credit movements, or a movement split. ────
export function netMovement(openingMinor, closingMinor) {
  const net = toMinorUnits(closingMinor) - toMinorUnits(openingMinor);
  return { kind: "NET_MOVEMENT", net, is_gross_additions: false, is_movement_split: false, is_cash_flow: false,
    note: "Two TBs give the net movement only. Gross additions, credit movements and any split require transaction-level evidence; net movement is not automatically a cash flow." };
}
/** Attempting to split a net movement into additions/disposals from two TBs alone is refused. */
export function splitMovement() {
  throw new BoundaryRefusal("MOVEMENT_SPLIT_REQUIRES_TRANSACTION_EVIDENCE",
    { note: "A net movement cannot be decomposed into additions/disposals/transfers without transaction-level evidence." });
}

// ── Source imbalance survives a BALANCED adjustment. An adjustment must itself balance (Σdebit = Σcredit); a balanced
//    layer cannot cure an underlying source imbalance, and no balancing entry is ever invented. ───────────────────────
export function assertBalancedAdjustment(lines) {
  let d = 0n, c = 0n;
  for (const l of lines) {
    const ld = toMinorUnits(l.debitMinor ?? 0), lc = toMinorUnits(l.creditMinor ?? 0);
    if ((ld > 0n) === (lc > 0n)) throw new BoundaryRefusal("ADJUSTMENT_LINE_ONE_SIDE_ONLY", { line: l });
    d += ld; c += lc;
  }
  if (d !== c || d === 0n) throw new BoundaryRefusal("UNBALANCED_ADJUSTMENT", { debit: d, credit: c });
  return { debit: d, credit: c, balanced: true };
}
export function adjustedImbalance(sourceDebitMinor, sourceCreditMinor, adjustmentLines) {
  assertBalancedAdjustment(adjustmentLines);                      // throws unless the adjustment itself balances
  const srcDiff = toMinorUnits(sourceDebitMinor) - toMinorUnits(sourceCreditMinor);
  return { source_difference: srcDiff, adjustment_difference: 0n, adjusted_difference: srcDiff,
    note: "A balanced adjustment is a LAYER; it leaves the source imbalance unchanged. No balancing entry is invented." };
}

// ── Preserve source precision; a SIGNED prior figure (a signed value in the current column) is NOT a comparative
//    (a separate prior-period column). They are kept distinct, never merged. ─────────────────────────────────────────
export function classifyPriorRepresentation({ signedInCurrentColumn = null, comparativeColumnValue = null } = {}) {
  return {
    signed_prior_figure: signedInCurrentColumn == null ? null : toMinorUnits(signedInCurrentColumn),
    comparative_figure: comparativeColumnValue == null ? null : toMinorUnits(comparativeColumnValue),
    merged: false,
    note: "A signed prior figure carried in the current column is distinct from a comparative period column; they are preserved separately, never summed or substituted.",
  };
}

// ── Corrected sources are LINKED IMMUTABLE versions. The original signed artefact is never changed; dependent outputs are
//    re-evaluated (requires_revalidation), mirroring close_review_adjustments revalidation + layout_confirmations binding. ─
export function linkCorrectedVersion(original, corrected, dependentOutputs = []) {
  if (!original || !corrected || original.version === corrected.version) throw new BoundaryRefusal("CORRECTION_REQUIRES_NEW_VERSION", { original, corrected });
  return {
    supersedes: original.version,
    version: corrected.version,
    original_unchanged: true,                                     // the historical signed artefact is immutable
    affected_outputs: dependentOutputs.map((o) => ({ ...o, status: "requires_revalidation" })),
    note: "A correction is a new immutable version linked to the original. Affected outputs are re-evaluated; historical signed artefacts are never rewritten.",
  };
}

// ── MUSE observations are CANDIDATE rules, scoped and status-tracked — never a global prefix rule. ─────────────────────
export function museObservation({ entity, chartVersion, years, observation, evidence } = {}) {
  if (!entity || !chartVersion || !Array.isArray(years) || years.length === 0) throw new BoundaryRefusal("MUSE_OBSERVATION_REQUIRES_SCOPE", { entity, chartVersion, years });
  if (!evidence) throw new BoundaryRefusal("MUSE_OBSERVATION_REQUIRES_EVIDENCE", { observation });
  return {
    kind: "MUSE_CANDIDATE_RULE",
    scope: { entity, chartVersion, years: [...years].sort() },
    observation,
    evidence,
    status: "PROPOSED",                                           // PROPOSED → reviewer-approved; never auto-applied, never global
    is_global: false,
    reuse_requires_context_compatibility: true,                  // approval alone does not permit reuse (see reuseContext.mjs)
    note: "A MUSE observation is a candidate rule scoped to an entity, chart version and years, carrying evidence and a proposed/approved status. Approval does not authorise reuse; changed meaning or conflicting evidence reopens review.",
  };
}
