/**
 * maonoAnalyticalContract.ts — Ω∞ Phase 9: MAONO's canonical analytical
 * fact model + hardened variance/forecast-readiness contract.
 *
 * Pure, READ ONLY — no I/O, no Supabase, no LLM call. This module does
 * NOT replace the live maono-* edge functions (maono-compute,
 * maono-cashflow, maono-risk, maono-decide, maono-monitor,
 * maono-root-cause) — those are real, already deployed, and this session
 * has no live database or Deno runtime to test an edit against (the same
 * constraint that has held for every phase this session: untested writes
 * to a live financial system are never presented as "activated"). Editing
 * them blind would risk a live regression with no way to verify the fix.
 *
 * What this module IS: the canonical, testable, pure contract MAONO
 * analytics must satisfy — uncertainty as a first-class value, hardened
 * numeric safety, the accounting-fact-vs-analytical-inference boundary as
 * an unconditional function rather than a trust-me field, and a
 * provenance shape compatible with the future Certified Financial
 * Evidence Graph. It is intended for a LATER, separately-tested
 * integration into the live edge functions (mirroring how Phase 8's
 * controlledActivation.ts built the pure eligibility contract ahead of
 * any live write path).
 *
 * Reconnaissance finding (Ω∞ Phase 9, 2026-09-04): CLAUDE.md's documented
 * "PHASE_B_LOCKED guard... maono-* and safisha-pdf-extract return 503
 * unless MAONO_ENABLED is set" does not exist anywhere in the live code —
 * grepped across every maono-* function and safisha-pdf-extract, and
 * across the entire src/ tree. MonitorWorkspace.tsx's own docstring
 * already says "Always available — no lock gate." MAONO is already live,
 * front-to-back, gated only by a genuine data-readiness check (a
 * completed, valid upload with a company_id) — never by a feature flag.
 * The Financial Twin firewall is already real: every maono-* write
 * targets only MAONO-namespaced tables (variance_runs, variance_analyses,
 * variance_alerts, cashflow_forecasts, maono_insights,
 * maono_monitor_runs) — confirmed by reading every .from()/.insert()/
 * .update()/.rpc() call site and the RPC definitions themselves
 * (maono_write_alert INSERTs only into variance_alerts). maono-risk's
 * ai_model_used is "deterministic_zscore" (no LLM). maono-decide and
 * maono-root-cause do call Claude, but store the narrative as an
 * append-only maono_insights row alongside numeric_validation_passed/
 * numeric_validation_detail — the LLM's claims are checked against real
 * numbers before being stored as advisory, never as the metric itself.
 * None of this needed building; it needed recognizing and preserving.
 */

import type { ComparativeAmount } from "./comparativeEvidence";
// Ω∞ Phase 9: reuses Phase 8's certification-relationship vocabulary
// verbatim rather than redefining it — the same "linked to a certified
// upload" vs "the fact itself was certified" distinction applies
// identically to a MAONO analytical input as it does to a historical
// mapping-memory candidate. No competing vocabulary is introduced.
import type { CertificationRelationship } from "./mappingMemory";

// ── The analytical fact model (§8) ──────────────────────────────────────────

/**
 * Every MAONO result must declare which of these it is. An analytical
 * inference must never masquerade as an accounting fact — see
 * isAuthoritativeAccountingFact below, which is the only place this
 * distinction is allowed to matter.
 */
export type AnalyticalResultType =
  | "OBSERVED_FACT"      // a value read directly from SAFISHA/HESABU, unmodified
  | "DERIVED_METRIC"     // a pure computation over observed facts (e.g. a ratio)
  | "VARIANCE"
  | "TREND"
  | "FORECAST"
  | "RISK_SIGNAL"
  | "HYPOTHESIS"
  | "RECOMMENDATION";

/**
 * Ω∞ Phase 9 repair-forward (independent-certification HIGH-3): the prior
 * single-argument isAuthoritativeAccountingFact(resultType) was itself
 * unsafe — "OBSERVED_FACT" only means a value was read directly from an
 * upstream source UNMODIFIED; it says nothing about whether that upstream
 * source was itself certified/current. A resultType alone can never prove
 * authority, so this function now REQUIRES explicit provenance evidence
 * the caller must have independently established (via the existing
 * SAFISHA certification-readiness authority — computeCertificationReadiness/
 * tb_certifications, upload-identity-bound the same way
 * computeCertificationReadiness.ts already does — never re-derived or
 * assumed here). Renamed so the old, unsafe one-argument shape cannot be
 * accidentally reconstructed: this function's SIGNATURE forces the
 * caller to supply evidence, not just a label.
 */
export type UpstreamSourceKind = "SAFISHA" | "HESABU" | "MAONO_DERIVED";

export interface AuthorityProvenanceEvidence {
  upstreamSource: UpstreamSourceKind;
  /**
   * True ONLY when the caller has independently verified — via existing
   * certification/readiness authority, never inferred here — that this
   * specific fact traces to a CURRENT, certified TB (or a HESABU
   * computation built on one) for the exact company/period being
   * displayed. Defaults to nothing: there is no default; the caller must
   * state it explicitly, and "I didn't check" must be false, not absent.
   */
  certifiedUpstream: boolean;
}

/**
 * True ONLY for resultType OBSERVED_FACT whose upstream source is SAFISHA
 * or HESABU (never MAONO_DERIVED — MAONO cannot certify its own analytical
 * output into accounting authority) AND whose provenance has been
 * independently proven certified. Every DERIVED_METRIC/VARIANCE/TREND/
 * FORECAST/RISK_SIGNAL/HYPOTHESIS/RECOMMENDATION is unconditionally false,
 * regardless of how strong the upstream evidence is — MAONO's own
 * computation over a certified fact is still MAONO's analysis, not the
 * fact itself.
 */
export function hasAuthoritativeAccountingProvenance(
  resultType: AnalyticalResultType,
  evidence: AuthorityProvenanceEvidence,
): boolean {
  if (resultType !== "OBSERVED_FACT") return false;
  if (evidence.upstreamSource === "MAONO_DERIVED") return false;
  return evidence.certifiedUpstream === true;
}

/**
 * A risk signal, hypothesis, or recommendation is explicitly NEVER any of
 * these — matching V5's own list. Used only as documentation-by-type; no
 * runtime check can catch a mislabeled narrative, so the LLM-narrative
 * boundary (maono-decide/maono-root-cause) is enforced by never letting
 * generated text populate a KNOWN AnalyticalValue — see fromHesabuResult.
 */
export type ProhibitedAuthorityClaim =
  | "FRAUD_FINDING"
  | "AUDIT_OPINION"
  | "TAX_VIOLATION"
  | "MISSTATEMENT_CONCLUSION"
  | "PROFESSIONAL_ACCOUNTING_AUTHORITY";

// ── Uncertainty as a first-class value (§7) ──────────────────────────────────

/**
 * Mirrors comparativeEvidence.ts's ComparativeAmount discriminant
 * vocabulary (KNOWN/ZERO/MISSING/NOT_APPLICABLE) plus a fifth state,
 * CANNOT_ASSESS, for MAONO-specific propagation (e.g. HESABU itself
 * returned CANNOT_ASSESS, or a MAONO computation's own precondition
 * failed). Deliberately a DISTINCT type, not a re-export: ComparativeAmount
 * is Phase 4's authority over comparative PERIOD amounts specifically;
 * AnalyticalValue is MAONO's general "any number with explicit
 * uncertainty" wrapper, used for current-period observed facts too, where
 * ComparativeAmount's contract does not apply. See fromComparativeAmount
 * for the one-way adapter — Phase 4 is reused, never duplicated or
 * re-derived.
 */
export type AnalyticalValue =
  | { state: "KNOWN"; value: number }
  | { state: "ZERO"; value: 0 }
  | { state: "MISSING" }
  | { state: "NOT_APPLICABLE" }
  | { state: "CANNOT_ASSESS"; reason: string };

/** One-way adapter from Phase 4's ComparativeAmount — never the reverse; Phase 4 authority is not touched. */
export function fromComparativeAmount(amount: ComparativeAmount): AnalyticalValue {
  switch (amount.state) {
    case "KNOWN": return { state: "KNOWN", value: amount.value };
    case "ZERO": return { state: "ZERO", value: 0 };
    case "MISSING": return { state: "MISSING" };
    case "NOT_APPLICABLE": return { state: "NOT_APPLICABLE" };
  }
}

/**
 * Wraps a raw upstream HESABU/SAFISHA numeric result (or its absence) as
 * an AnalyticalValue — the single point where a `null`/non-finite
 * upstream value is turned into an explicit uncertainty state instead of
 * silently becoming 0. `null` with no reason given means "simply
 * missing"; a reason means the upstream engine itself said CANNOT_ASSESS
 * (propagated verbatim, per §14 — MAONO never recomputes what HESABU
 * could not compute).
 */
export function fromHesabuResult(hesabuValue: number | null, cannotAssessReason?: string): AnalyticalValue {
  if (hesabuValue === null) {
    return cannotAssessReason
      ? { state: "CANNOT_ASSESS", reason: cannotAssessReason }
      : { state: "MISSING" };
  }
  if (!Number.isFinite(hesabuValue)) {
    return { state: "CANNOT_ASSESS", reason: `Upstream value is not finite (NaN/Infinity): ${String(hesabuValue)}` };
  }
  return hesabuValue === 0 ? { state: "ZERO", value: 0 } : { state: "KNOWN", value: hesabuValue };
}

function numericValueOf(v: AnalyticalValue): number | null {
  if (v.state === "KNOWN") return v.value;
  if (v.state === "ZERO") return 0;
  return null;
}

// ── Company/period identity binding (§15) ────────────────────────────────────

export interface AnalyticalContext {
  companyId: string;
  periodYear: number;
  currency: string;
}

/** A cached/previous result bound to a different company or period is stale — never displayed as current. */
export function isStaleContext(cached: AnalyticalContext, current: AnalyticalContext): boolean {
  return cached.companyId !== current.companyId || cached.periodYear !== current.periodYear;
}

// ── Provenance contract (§20/§21) — shape only, not the Evidence Graph itself ─

export interface AnalyticalProvenance {
  metricId: string;
  metricVersion: string;
  upstreamSource: UpstreamSourceKind;
  /** e.g. a tb_certifications id or a HESABU engine_run id, when the caller has one. Never fabricated when absent. */
  upstreamFactId?: string;
  /** Never claims the fact itself was certified — only that its upload is/isn't linked to a current certification. Reused from Phase 8, not redefined. */
  certificationRelationship?: CertificationRelationship;
  /** Which HESABU-owned computation this traces to (e.g. "comparativePeriodAdapter", "primaryCashFlowEngine", "movementSchedules"), when the caller knows. */
  hesabuRelationship?: string;
  calculationInputs?: Record<string, number | string | null>;
  thresholdOrConfigId?: string;
  calculatedAt?: string;
}

// ── Single MAONO trust-input contract (§4/§9) — the narrow "adapter" ────────
// this session can safely build: no live edge-function rewrite, just the
// pure classification rule every future adapter must implement.

export type MaonoInputTrustLevel =
  | "TRUSTED_ACCOUNTING_INPUT"
  | "ANALYTICAL_DERIVATION"
  | "UNAVAILABLE";

export interface MaonoInputTrustAssessment {
  trustLevel: MaonoInputTrustLevel;
  reason: string;
}

/**
 * The one rule every MAONO input-sourcing path must satisfy: a caller may
 * never merely LABEL data "trusted." MAONO's own computations are always
 * ANALYTICAL_DERIVATION, never TRUSTED_ACCOUNTING_INPUT, regardless of how
 * trustworthy their inputs were. An upstream fact is TRUSTED_ACCOUNTING_INPUT
 * only when it is OBSERVED_FACT, linked to a currently certified upload,
 * AND the caller has independently confirmed that certified provenance —
 * any one of those missing fails closed to UNAVAILABLE, never silently
 * downgraded to a guess.
 */
export function assessMaonoInputTrust(
  resultType: AnalyticalResultType,
  evidence: AuthorityProvenanceEvidence,
  certificationRelationship: CertificationRelationship,
): MaonoInputTrustAssessment {
  if (evidence.upstreamSource === "MAONO_DERIVED") {
    return {
      trustLevel: "ANALYTICAL_DERIVATION",
      reason: "Value is MAONO's own computation, not an upstream accounting fact — never treated as trusted input regardless of what it was computed from.",
    };
  }
  if (certificationRelationship !== "LINKED_TO_CERTIFIED_UPLOAD") {
    return {
      trustLevel: "UNAVAILABLE",
      reason: `Upstream fact's upload is not linked to a currently certified TB (${certificationRelationship}) — never treated as trusted, never silently used anyway.`,
    };
  }
  if (!evidence.certifiedUpstream) {
    return {
      trustLevel: "UNAVAILABLE",
      reason: "Caller could not independently confirm certified upstream provenance for this specific fact.",
    };
  }
  return resultType === "OBSERVED_FACT"
    ? { trustLevel: "TRUSTED_ACCOUNTING_INPUT", reason: "Directly observed, unmodified, from a certified SAFISHA/HESABU source." }
    : { trustLevel: "ANALYTICAL_DERIVATION", reason: "Computed by MAONO over trusted inputs — the computation itself is not an accounting fact." };
}

export interface AnalyticalResult {
  resultType: AnalyticalResultType;
  context: AnalyticalContext;
  value: AnalyticalValue;
  provenance: AnalyticalProvenance;
}

// ── Hardened variance (§9) ───────────────────────────────────────────────────

export type VarianceDirection = "FAVORABLE" | "UNFAVORABLE" | "NEUTRAL" | "NOT_APPLICABLE";

export interface VarianceResult {
  absoluteVariance: AnalyticalValue;
  percentageVariance: AnalyticalValue;
  direction: VarianceDirection;
}

/**
 * Mirrors the live maono-compute edge function's already-correct
 * variancePct() zero-denominator handling (budget/comparative === 0 ->
 * 0% if actual is also 0, else CANNOT_ASSESS — never Infinity, never a
 * fabricated percentage) — generalized into a pure, tested, reusable
 * contract. `higherIsFavorable` lets the caller supply account-nature
 * direction (e.g. revenue: true, expense: false) without this function
 * hardcoding any framework/account-nature assumption itself.
 */
export function computeVariance(
  actual: AnalyticalValue,
  comparative: AnalyticalValue,
  options: { higherIsFavorable?: boolean } = {},
): VarianceResult {
  const cannotAssess = (reason: string): VarianceResult => ({
    absoluteVariance: { state: "CANNOT_ASSESS", reason },
    percentageVariance: { state: "CANNOT_ASSESS", reason },
    direction: "NOT_APPLICABLE",
  });

  const actualValue = numericValueOf(actual);
  if (actualValue === null) {
    return cannotAssess(`Actual value is ${actual.state} — variance cannot be computed.`);
  }
  const comparativeValue = numericValueOf(comparative);
  if (comparativeValue === null) {
    return cannotAssess(`Comparative value is ${comparative.state} — variance cannot be computed.`);
  }
  if (!Number.isFinite(actualValue) || !Number.isFinite(comparativeValue)) {
    return cannotAssess("Actual or comparative value is not finite (NaN/Infinity) — never coerced.");
  }

  const absolute = actualValue - comparativeValue;
  if (!Number.isFinite(absolute)) {
    return cannotAssess("Computed absolute variance overflowed to a non-finite value.");
  }

  let percentageVariance: AnalyticalValue;
  if (comparativeValue === 0) {
    percentageVariance = actualValue === 0
      ? { state: "ZERO", value: 0 }
      : { state: "CANNOT_ASSESS", reason: "Comparative value is zero — percentage variance is undefined, never Infinity." };
  } else {
    const pct = (absolute / Math.abs(comparativeValue)) * 100;
    percentageVariance = Number.isFinite(pct)
      ? (pct === 0 ? { state: "ZERO", value: 0 } : { state: "KNOWN", value: pct })
      : { state: "CANNOT_ASSESS", reason: "Computed percentage variance overflowed to a non-finite value." };
  }

  const higherIsFavorable = options.higherIsFavorable ?? true;
  const direction: VarianceDirection =
    absolute === 0 ? "NEUTRAL" :
    (absolute > 0) === higherIsFavorable ? "FAVORABLE" : "UNFAVORABLE";

  return {
    absoluteVariance: absolute === 0 ? { state: "ZERO", value: 0 } : { state: "KNOWN", value: absolute },
    percentageVariance,
    direction,
  };
}

// ── Forecast readiness (§10) — deterministic gate, no LLM ────────────────────

export type ForecastReadiness =
  | { status: "SUFFICIENT_HISTORY"; observationCount: number }
  | { status: "INSUFFICIENT_HISTORY"; observationCount: number; minimumRequired: number };

/**
 * Counts only genuinely evidenced observations (KNOWN/ZERO) — MISSING /
 * NOT_APPLICABLE / CANNOT_ASSESS never count toward sufficiency, and are
 * never coerced into a usable data point. Deterministic; no confidence
 * score is invented from an insufficient sample.
 */
export function assessForecastReadiness(
  observations: AnalyticalValue[],
  minimumRequired: number,
): ForecastReadiness {
  const observationCount = observations.filter((o) => o.state === "KNOWN" || o.state === "ZERO").length;
  return observationCount >= minimumRequired
    ? { status: "SUFFICIENT_HISTORY", observationCount }
    : { status: "INSUFFICIENT_HISTORY", observationCount, minimumRequired };
}
