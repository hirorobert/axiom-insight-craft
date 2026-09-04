/**
 * primaryCashFlowEngine.ts — Ω∞ V5 Phase 5 final closure.
 *
 * PURE FUNCTIONS ONLY. No Supabase, no DB, no network, no timestamps, no
 * random ids, no writes. Completes the locked three-control architecture:
 *
 *   A. PRIMARY CASH-FLOW ENGINE (this file) — consumes its own
 *      authoritative PrimaryCashFlowFacts and derives Operating/Investing/
 *      Financing subtotals + net movement in cash.
 *   B. OPERATING-CF RECONCILIATION ENGINE — cashFlowEngines.ts's existing,
 *      certified `buildOperatingCashFlowReconciliation`. Already
 *      independently derives operating cash flow from surplus/deficit +
 *      non-cash adjustments +/- working-capital movements; already never
 *      accepted a primary-engine result as input. Unchanged by this file.
 *   C. CASH-POSITION RECONCILIATION — cashFlowEngines.ts's existing,
 *      certified `verifyCashPositionReconciliation` (Gate C). Unchanged.
 *      Never dual-engine proof; see its own doc comment.
 *
 * This file additionally implements the DUAL-ENGINE OPERATING-CF GATE
 * (comparing A's and B's independently-derived operating cash flow) and a
 * pure SIGN-OFF gate result over that comparison.
 *
 * ── Independence, structurally enforced ─────────────────────────────────
 * `runPrimaryCashFlowEngine(facts: PrimaryCashFlowFacts)` has no parameter
 * capable of carrying a reconciliation-engine result — there is no field
 * named anything like `reconciledOperatingCashFlow` anywhere in
 * `PrimaryCashFlowFacts`. This file never imports
 * `buildOperatingCashFlowReconciliation`, `OperatingCashFlowReconciliation`,
 * or any of cashFlowEngines.ts's Engine-B-specific exports — only the
 * certified, dimension-neutral primitives it needs
 * (`resolveAssessableComparativeAmount`, `isNonBlankString`,
 * `MaterialityThreshold`). The caller of `evaluateDualEngineOperatingCashFlowGate`
 * supplies Engine B's already-independently-computed result as an opaque
 * `ReconciliationOperatingCashFlowResult` -- this file never calls Engine B,
 * never reads its internals, and Engine B (cashFlowEngines.ts) never
 * imports anything from this file. The dependency graph is one-directional:
 * this file → cashFlowEngines.ts, never the reverse.
 *
 * ── SAFISHA transaction-ledger gap (DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001) ──
 * `safisha_transactions` is NOT used, referenced, or relied upon anywhere in
 * this file. `PrimaryCashFlowFacts` is a permanent, producer-agnostic
 * contract: a future authoritative producer (a hardened SAFISHA ledger, a
 * certified movement schedule, or another certified evidence source) can
 * satisfy it later without requiring this engine to be redesigned. Until
 * such a producer exists, callers simply have no facts to supply, and the
 * correct, honest result is CANNOT_ASSESS -- never a guessed, inferred, or
 * fabricated figure.
 *
 * ── Method labelling (no fake direct-method claim) ──────────────────────
 * `PrimaryCashFlowFacts.evidenceBasis` is the caller's OWN designation of
 * what kind of evidence it is supplying. This engine never inspects the
 * numbers to infer or assert an IAS 7/IPSAS 2 method label -- it only
 * echoes the caller's own designation back in the result, unchanged.
 *
 * ── KINGA firewall ───────────────────────────────────────────────────────
 * Zero import from, or reference to, kinga-tax-engine, KINGA, TRA, ITA,
 * EFDMS, VAT, WHT, or any Tanzania-specific concept. `kinga-tax-engine`'s
 * `scfEngine` was read only as algorithmic precedent during design (indirect
 * method: PBT + non-cash add-backs +/- working-capital deltas) -- nothing
 * from its actual code is imported, copied, or depended upon.
 */

import type { ComparativeAmount } from "./comparativeEvidence";
import {
  isNonBlankString,
  resolveAssessableComparativeAmount,
  type MaterialityThreshold,
} from "./cashFlowEngines";

// ── A. Primary cash-flow fact contract ──────────────────────────────────────

/**
 * The caller's own designation of what the supplied facts represent.
 * Never inferred by this engine from the numbers themselves.
 */
export type PrimaryCashFlowEvidenceBasis =
  | "GROSS_RECEIPTS_AND_PAYMENTS"
  | "OTHER_AUTHORITATIVE_BASIS";

/**
 * Permanent, producer-agnostic input contract. A future authoritative
 * producer (hardened SAFISHA ledger, certified movement schedule, or any
 * other certified evidence source) satisfies this shape -- this engine
 * never changes when the producer changes.
 *
 * Every raw fact reuses the certified ComparativeAmount contract
 * (KNOWN/ZERO/MISSING/NOT_APPLICABLE) so a genuinely unavailable fact stays
 * structurally absent, never silently 0.
 */
export interface PrimaryCashFlowFacts {
  currencyCode: string;
  evidenceBasis: PrimaryCashFlowEvidenceBasis;
  operatingCashInflows: ComparativeAmount;
  operatingCashOutflows: ComparativeAmount;
  investingCashInflows: ComparativeAmount;
  investingCashOutflows: ComparativeAmount;
  financingCashInflows: ComparativeAmount;
  financingCashOutflows: ComparativeAmount;
}

export interface PrimaryCashFlowSectionResult {
  state: "KNOWN" | "CANNOT_ASSESS";
  /** null iff state is CANNOT_ASSESS. */
  netAmount: number | null;
}

export interface PrimaryCashFlowEngineResult {
  currencyCode: string;
  evidenceBasis: PrimaryCashFlowEvidenceBasis;
  operating: PrimaryCashFlowSectionResult;
  investing: PrimaryCashFlowSectionResult;
  financing: PrimaryCashFlowSectionResult;
  /** null iff overallState is CANNOT_ASSESS. */
  netMovementInCash: number | null;
  overallState: "ASSESSABLE" | "CANNOT_ASSESS";
}

function resolveSection(
  inflows: ComparativeAmount,
  outflows: ComparativeAmount,
): PrimaryCashFlowSectionResult {
  const resolvedInflows = resolveAssessableComparativeAmount(inflows);
  const resolvedOutflows = resolveAssessableComparativeAmount(outflows);
  if (!resolvedInflows.assessable || !resolvedOutflows.assessable) {
    return { state: "CANNOT_ASSESS", netAmount: null };
  }
  return { state: "KNOWN", netAmount: resolvedInflows.value - resolvedOutflows.value };
}

/**
 * Derives the primary Statement of Cash Flows sections from authoritative,
 * independently-supplied facts. Never reads, calls, or depends on
 * cashFlowEngines.ts's reconciliation engine or Gate C. When required facts
 * are unavailable (MISSING/NOT_APPLICABLE) or malformed (runtime-invalid
 * ComparativeAmount state, non-finite KNOWN/ZERO value), the affected
 * section -- and therefore the overall result -- is CANNOT_ASSESS, never a
 * guessed or defaulted figure.
 */
export function runPrimaryCashFlowEngine(facts: PrimaryCashFlowFacts): PrimaryCashFlowEngineResult {
  if (!isNonBlankString(facts.currencyCode)) {
    throw new Error(
      `runPrimaryCashFlowEngine: currencyCode must be a non-empty, non-whitespace string (received: ${JSON.stringify(facts.currencyCode)}).`,
    );
  }

  const operating = resolveSection(facts.operatingCashInflows, facts.operatingCashOutflows);
  const investing = resolveSection(facts.investingCashInflows, facts.investingCashOutflows);
  const financing = resolveSection(facts.financingCashInflows, facts.financingCashOutflows);

  const allAssessable = operating.state === "KNOWN" && investing.state === "KNOWN" && financing.state === "KNOWN";

  return {
    currencyCode: facts.currencyCode,
    evidenceBasis: facts.evidenceBasis,
    operating,
    investing,
    financing,
    netMovementInCash: allAssessable
      ? (operating.netAmount as number) + (investing.netAmount as number) + (financing.netAmount as number)
      : null,
    overallState: allAssessable ? "ASSESSABLE" : "CANNOT_ASSESS",
  };
}

// ── B. Reconciliation engine's operating-CF result, as an opaque input ──────

/**
 * The Reconciliation Engine's (cashFlowEngines.ts's
 * `buildOperatingCashFlowReconciliation`) already-independently-derived
 * operating cash flow, wrapped by the CALLER as an assessable/unassessable
 * fact for the dual-engine gate below. This file never constructs this
 * value itself and never calls the reconciliation engine -- the caller
 * decides ASSESSABLE only when it actually has a real
 * netCashFromOperatingActivities figure to report (e.g. a certified
 * surplus/deficit was available to feed the reconciliation engine).
 */
export type ReconciliationOperatingCashFlowResult =
  | { state: "ASSESSABLE"; operatingCashFlow: number }
  | { state: "CANNOT_ASSESS"; reason: string };

// ── Dual-engine operating-CF gate ────────────────────────────────────────────

export type DualEngineGateStatus = "PASS" | "FAIL" | "CANNOT_ASSESS";

export interface DualEngineGateResult {
  status: DualEngineGateStatus;
  /** null iff either side is CANNOT_ASSESS. */
  primaryOperatingCashFlow: number | null;
  /** null iff either side is CANNOT_ASSESS. */
  reconciliationOperatingCashFlow: number | null;
  /** null iff status is CANNOT_ASSESS. */
  difference: number | null;
  /** null iff status is CANNOT_ASSESS. */
  thresholdApplied: number | null;
  currencyCode: string;
}

/**
 * Compares Engine A's (primary) and Engine B's (reconciliation)
 * independently-derived operating cash flow figures. PASS/FAIL only when
 * BOTH are assessable; CANNOT_ASSESS whenever either is not -- CANNOT_ASSESS
 * never silently becomes PASS. Materiality is caller-supplied, validated
 * with the same fail-closed rules as Gate C (finite, >= 0 thresholds,
 * non-blank currency, matching currency) -- no ROUNDING_EPSILON, no default
 * currency, no hardcoded amount.
 */
export function evaluateDualEngineOperatingCashFlowGate(
  primary: PrimaryCashFlowEngineResult,
  reconciliation: ReconciliationOperatingCashFlowResult,
  materiality: MaterialityThreshold,
): DualEngineGateResult {
  if (!isNonBlankString(primary.currencyCode)) {
    throw new Error(
      `evaluateDualEngineOperatingCashFlowGate: primary.currencyCode must be a non-empty, non-whitespace string (received: ${JSON.stringify(primary.currencyCode)}).`,
    );
  }
  if (!isNonBlankString(materiality.currencyCode)) {
    throw new Error(
      `evaluateDualEngineOperatingCashFlowGate: materiality.currencyCode must be a non-empty, non-whitespace string (received: ${JSON.stringify(materiality.currencyCode)}).`,
    );
  }
  if (!Number.isFinite(materiality.percentageThreshold) || materiality.percentageThreshold < 0) {
    throw new Error(
      `evaluateDualEngineOperatingCashFlowGate: materiality.percentageThreshold must be a finite number >= 0 (received: ${String(materiality.percentageThreshold)}).`,
    );
  }
  if (!Number.isFinite(materiality.absoluteThreshold) || materiality.absoluteThreshold < 0) {
    throw new Error(
      `evaluateDualEngineOperatingCashFlowGate: materiality.absoluteThreshold must be a finite number >= 0 (received: ${String(materiality.absoluteThreshold)}).`,
    );
  }
  if (primary.currencyCode.trim() !== materiality.currencyCode.trim()) {
    throw new Error(
      `evaluateDualEngineOperatingCashFlowGate: currency mismatch between primary ('${primary.currencyCode}') and materiality ('${materiality.currencyCode}') -- refusing to compare across currencies.`,
    );
  }

  if (primary.overallState !== "ASSESSABLE" || primary.operating.state !== "KNOWN" || reconciliation.state !== "ASSESSABLE") {
    return {
      status: "CANNOT_ASSESS",
      primaryOperatingCashFlow: primary.operating.state === "KNOWN" ? primary.operating.netAmount : null,
      reconciliationOperatingCashFlow: reconciliation.state === "ASSESSABLE" ? reconciliation.operatingCashFlow : null,
      difference: null,
      thresholdApplied: null,
      currencyCode: primary.currencyCode,
    };
  }

  if (!Number.isFinite(reconciliation.operatingCashFlow)) {
    throw new Error(
      `evaluateDualEngineOperatingCashFlowGate: reconciliation.operatingCashFlow is not a finite number (received: ${String(reconciliation.operatingCashFlow)}).`,
    );
  }

  const primaryOCF = primary.operating.netAmount as number;
  const reconciliationOCF = reconciliation.operatingCashFlow;
  const difference = primaryOCF - reconciliationOCF;
  // Conservative anchor: the larger of the two magnitudes, so neither side
  // is presumed more authoritative than the other for materiality purposes.
  const magnitude = Math.max(Math.abs(primaryOCF), Math.abs(reconciliationOCF));
  const thresholdApplied = Math.max(magnitude * materiality.percentageThreshold, materiality.absoluteThreshold);
  const status: DualEngineGateStatus = Math.abs(difference) <= thresholdApplied ? "PASS" : "FAIL";

  return {
    status,
    primaryOperatingCashFlow: primaryOCF,
    reconciliationOperatingCashFlow: reconciliationOCF,
    difference,
    thresholdApplied,
    currencyCode: primary.currencyCode,
  };
}

// ── Sign-off gate (pure typed result; no DB/workflow infrastructure) ───────

/**
 * No production sign-off gate infrastructure exists as a pure TS module
 * this engine could integrate through (the only `signOff`-adjacent module
 * found, `computeComplianceScore.ts`, performs its own Supabase reads and
 * treats sign-off status as one of several scoring inputs for a compliance
 * dashboard -- not an authority boundary, and not pure). Per V5 Phase 5's
 * own instruction, no DB/workflow infrastructure is created here. This is
 * a pure typed result recording the future integration boundary: a later
 * edge function would combine this result with hesabu-validate's other
 * findings before writing to the real `statement_sign_offs` /
 * `hesabu_gate_before_signoff` trigger path (CLAUDE.md §4.6) -- this
 * module makes no DB write and defines no trigger.
 */
export type SignOffGateStatus = "SIGNOFF_ALLOWED" | "SIGNOFF_BLOCKED" | "CANNOT_ASSESS";

export interface SignOffGateResult {
  status: SignOffGateStatus;
  reasons: string[];
}

/**
 * PASS => this cash-flow gate does not block sign-off -- it does NOT imply
 * all other sign-off requirements (H-06/H-07/H-08, professional review,
 * etc.) are satisfied; those remain separate, independent controls.
 * FAIL => blocked.
 * CANNOT_ASSESS => per V5 Phase 5's own instruction, blocked by default
 * (no existing repository policy establishes an exception) -- but reported
 * as its own distinct status, never silently collapsed into FAIL, so a
 * future integration can apply an explicit, documented policy if one is
 * ever established.
 */
export function evaluateCashFlowSignOffGate(gate: DualEngineGateResult): SignOffGateResult {
  switch (gate.status) {
    case "PASS":
      return {
        status: "SIGNOFF_ALLOWED",
        reasons: [
          "Dual-engine operating cash flow cross-check passed within materiality. This does not certify that all other sign-off requirements are satisfied.",
        ],
      };
    case "FAIL":
      return {
        status: "SIGNOFF_BLOCKED",
        reasons: [
          `Dual-engine operating cash flow cross-check failed: |difference| ${String(gate.difference)} exceeds materiality threshold ${String(gate.thresholdApplied)}.`,
        ],
      };
    case "CANNOT_ASSESS":
      return {
        status: "CANNOT_ASSESS",
        reasons: [
          "One or both cash-flow engines could not produce an authoritative operating cash flow result. No existing repository policy establishes an exception, so this must be treated as blocking sign-off until one does.",
        ],
      };
    default: {
      const exhaustive: never = gate.status;
      throw new Error(`evaluateCashFlowSignOffGate: unrecognized DualEngineGateStatus (received: ${String(exhaustive)}).`);
    }
  }
}
