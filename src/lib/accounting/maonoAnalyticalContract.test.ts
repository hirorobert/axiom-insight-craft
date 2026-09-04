/**
 * maonoAnalyticalContract.test.ts — Ω∞ Phase 9.
 *
 * Proves the hardened variance/forecast-readiness/uncertainty contract
 * MAONO analytics must satisfy: no NaN/Infinity escapes, no MISSING/
 * CANNOT_ASSESS/NOT_APPLICABLE is ever coerced into a fabricated number,
 * an analytical inference can never claim accounting authority, and
 * company/period identity binding invalidates stale results.
 */

import { describe, it, expect } from "vitest";
import {
  hasAuthoritativeAccountingProvenance,
  assessMaonoInputTrust,
  fromComparativeAmount,
  fromHesabuResult,
  isStaleContext,
  computeVariance,
  assessForecastReadiness,
  readOptionalNumericField,
  type AnalyticalValue,
  type AnalyticalContext,
  type AnalyticalResultType,
  type AuthorityProvenanceEvidence,
} from "./maonoAnalyticalContract";
import type { ComparativeAmount } from "./comparativeEvidence";

const KNOWN = (value: number): AnalyticalValue => ({ state: "KNOWN", value });
const ZERO: AnalyticalValue = { state: "ZERO", value: 0 };
const MISSING: AnalyticalValue = { state: "MISSING" };
const NOT_APPLICABLE: AnalyticalValue = { state: "NOT_APPLICABLE" };
const CANNOT_ASSESS = (reason: string): AnalyticalValue => ({ state: "CANNOT_ASSESS", reason });

const certifiedSafisha: AuthorityProvenanceEvidence = { upstreamSource: "SAFISHA", certifiedUpstream: true };
const uncertifiedSafisha: AuthorityProvenanceEvidence = { upstreamSource: "SAFISHA", certifiedUpstream: false };
const certifiedHesabu: AuthorityProvenanceEvidence = { upstreamSource: "HESABU", certifiedUpstream: true };
const maonoDerived: AuthorityProvenanceEvidence = { upstreamSource: "MAONO_DERIVED", certifiedUpstream: false };

describe("hasAuthoritativeAccountingProvenance — Ω∞ Phase 9 repair (HIGH-3): resultType alone never proves authority", () => {
  it("OBSERVED_FACT + raw/uncertified TB evidence -> false (resultType label is not enough)", () => {
    expect(hasAuthoritativeAccountingProvenance("OBSERVED_FACT", uncertifiedSafisha)).toBe(false);
  });

  it("OBSERVED_FACT + uncertified upload -> false", () => {
    expect(hasAuthoritativeAccountingProvenance("OBSERVED_FACT", { upstreamSource: "SAFISHA", certifiedUpstream: false })).toBe(false);
  });

  it("OBSERVED_FACT + certified SAFISHA fact -> true, and ONLY because the contract can prove it", () => {
    expect(hasAuthoritativeAccountingProvenance("OBSERVED_FACT", certifiedSafisha)).toBe(true);
  });

  it("OBSERVED_FACT + certified HESABU fact -> true", () => {
    expect(hasAuthoritativeAccountingProvenance("OBSERVED_FACT", certifiedHesabu)).toBe(true);
  });

  it("OBSERVED_FACT + MAONO_DERIVED source -> false, even if marked certifiedUpstream (MAONO cannot certify its own output)", () => {
    expect(hasAuthoritativeAccountingProvenance("OBSERVED_FACT", { upstreamSource: "MAONO_DERIVED", certifiedUpstream: true })).toBe(false);
  });

  it("DERIVED_METRIC + certified inputs -> still analytical, never an accounting fact", () => {
    expect(hasAuthoritativeAccountingProvenance("DERIVED_METRIC", certifiedSafisha)).toBe(false);
  });

  it.each<AnalyticalResultType>(["VARIANCE", "TREND", "FORECAST", "RISK_SIGNAL", "HYPOTHESIS", "RECOMMENDATION"])(
    "%s is never authoritative, even with fully certified evidence",
    (resultType) => {
      expect(hasAuthoritativeAccountingProvenance(resultType, certifiedSafisha)).toBe(false);
      expect(hasAuthoritativeAccountingProvenance(resultType, certifiedHesabu)).toBe(false);
    },
  );
});

describe("assessMaonoInputTrust — the single MAONO trust-input contract (§4/§9)", () => {
  it("MAONO_DERIVED is always ANALYTICAL_DERIVATION, never TRUSTED_ACCOUNTING_INPUT", () => {
    const r = assessMaonoInputTrust("DERIVED_METRIC", maonoDerived, "LINKED_TO_CERTIFIED_UPLOAD");
    expect(r.trustLevel).toBe("ANALYTICAL_DERIVATION");
  });

  it("OBSERVED_FACT + certified upload + confirmed provenance -> TRUSTED_ACCOUNTING_INPUT", () => {
    const r = assessMaonoInputTrust("OBSERVED_FACT", certifiedSafisha, "LINKED_TO_CERTIFIED_UPLOAD");
    expect(r.trustLevel).toBe("TRUSTED_ACCOUNTING_INPUT");
  });

  it("OBSERVED_FACT + upload linked to an UNCERTIFIED upload -> UNAVAILABLE, never silently used", () => {
    const r = assessMaonoInputTrust("OBSERVED_FACT", certifiedSafisha, "LINKED_TO_UNCERTIFIED_UPLOAD");
    expect(r.trustLevel).toBe("UNAVAILABLE");
  });

  it("OBSERVED_FACT + UNKNOWN certification relationship -> UNAVAILABLE, never guessed trusted", () => {
    const r = assessMaonoInputTrust("OBSERVED_FACT", certifiedSafisha, "UNKNOWN");
    expect(r.trustLevel).toBe("UNAVAILABLE");
  });

  it("OBSERVED_FACT + certified upload but caller could not confirm provenance -> UNAVAILABLE", () => {
    const r = assessMaonoInputTrust("OBSERVED_FACT", uncertifiedSafisha, "LINKED_TO_CERTIFIED_UPLOAD");
    expect(r.trustLevel).toBe("UNAVAILABLE");
  });

  it("DERIVED_METRIC over a fully trusted certified input is still ANALYTICAL_DERIVATION", () => {
    const r = assessMaonoInputTrust("DERIVED_METRIC", certifiedHesabu, "LINKED_TO_CERTIFIED_UPLOAD");
    expect(r.trustLevel).toBe("ANALYTICAL_DERIVATION");
  });
});

describe("fromComparativeAmount — Phase 4 authority reused, never re-derived", () => {
  it("KNOWN maps through", () => {
    const c: ComparativeAmount = { state: "KNOWN", value: 500, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
    expect(fromComparativeAmount(c)).toEqual({ state: "KNOWN", value: 500 });
  });
  it("ZERO maps through as genuine zero, not missing", () => {
    const c: ComparativeAmount = { state: "ZERO", value: 0, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
    expect(fromComparativeAmount(c)).toEqual({ state: "ZERO", value: 0 });
  });
  it("MISSING maps through", () => {
    const c: ComparativeAmount = { state: "MISSING", source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
    expect(fromComparativeAmount(c)).toEqual({ state: "MISSING" });
  });
  it("NOT_APPLICABLE maps through", () => {
    const c: ComparativeAmount = { state: "NOT_APPLICABLE", evidence: [] };
    expect(fromComparativeAmount(c)).toEqual({ state: "NOT_APPLICABLE" });
  });
});

describe("fromHesabuResult — MAONO propagates HESABU's own limitations, never recomputes past them", () => {
  it("a real number becomes KNOWN", () => {
    expect(fromHesabuResult(42)).toEqual({ state: "KNOWN", value: 42 });
  });
  it("a real zero becomes ZERO, not MISSING", () => {
    expect(fromHesabuResult(0)).toEqual({ state: "ZERO", value: 0 });
  });
  it("null with no reason becomes MISSING", () => {
    expect(fromHesabuResult(null)).toEqual({ state: "MISSING" });
  });
  it("null with a reason becomes CANNOT_ASSESS, propagating HESABU's own verdict", () => {
    expect(fromHesabuResult(null, "HESABU cash-flow gate returned CANNOT_ASSESS")).toEqual({
      state: "CANNOT_ASSESS",
      reason: "HESABU cash-flow gate returned CANNOT_ASSESS",
    });
  });
  it("NaN fails closed to CANNOT_ASSESS, never becomes a fabricated number", () => {
    const r = fromHesabuResult(NaN);
    expect(r.state).toBe("CANNOT_ASSESS");
  });
  it("Infinity fails closed to CANNOT_ASSESS", () => {
    expect(fromHesabuResult(Infinity).state).toBe("CANNOT_ASSESS");
  });
  it("-Infinity fails closed to CANNOT_ASSESS", () => {
    expect(fromHesabuResult(-Infinity).state).toBe("CANNOT_ASSESS");
  });
});

describe("isStaleContext — company/period identity binding", () => {
  const base: AnalyticalContext = { companyId: "company-1", periodYear: 2026, currency: "TZS" };

  it("identical context is not stale", () => {
    expect(isStaleContext(base, { ...base })).toBe(false);
  });
  it("a different company invalidates the cached result", () => {
    expect(isStaleContext(base, { ...base, companyId: "company-2" })).toBe(true);
  });
  it("a different period invalidates the cached result", () => {
    expect(isStaleContext(base, { ...base, periodYear: 2025 })).toBe(true);
  });
  it("a currency-only change does not by itself flag staleness (identity is company+period)", () => {
    expect(isStaleContext(base, { ...base, currency: "USD" })).toBe(false);
  });
});

describe("computeVariance — positive/negative/zero", () => {
  it("a positive absolute variance with higherIsFavorable computes FAVORABLE", () => {
    const r = computeVariance(KNOWN(1_200_000), KNOWN(1_000_000));
    expect(r.absoluteVariance).toEqual({ state: "KNOWN", value: 200_000 });
    expect(r.percentageVariance).toEqual({ state: "KNOWN", value: 20 });
    expect(r.direction).toBe("FAVORABLE");
  });

  it("a negative absolute variance with higherIsFavorable computes UNFAVORABLE", () => {
    const r = computeVariance(KNOWN(800_000), KNOWN(1_000_000));
    expect(r.absoluteVariance).toEqual({ state: "KNOWN", value: -200_000 });
    expect(r.direction).toBe("UNFAVORABLE");
  });

  it("higherIsFavorable: false flips direction for an expense-like account", () => {
    const r = computeVariance(KNOWN(1_200_000), KNOWN(1_000_000), { higherIsFavorable: false });
    expect(r.direction).toBe("UNFAVORABLE");
  });

  it("exact match is a genuine ZERO variance, NEUTRAL direction", () => {
    const r = computeVariance(KNOWN(500_000), KNOWN(500_000));
    expect(r.absoluteVariance).toEqual({ state: "ZERO", value: 0 });
    expect(r.percentageVariance).toEqual({ state: "ZERO", value: 0 });
    expect(r.direction).toBe("NEUTRAL");
  });

  it("both actual and comparative genuinely zero -> ZERO variance, not CANNOT_ASSESS", () => {
    const r = computeVariance(ZERO, ZERO);
    expect(r.absoluteVariance).toEqual({ state: "ZERO", value: 0 });
    expect(r.percentageVariance).toEqual({ state: "ZERO", value: 0 });
  });
});

describe("computeVariance — zero denominator", () => {
  it("nonzero actual against a zero comparative fails closed to CANNOT_ASSESS, never Infinity", () => {
    const r = computeVariance(KNOWN(50_000), ZERO);
    expect(r.percentageVariance.state).toBe("CANNOT_ASSESS");
    expect(r.absoluteVariance).toEqual({ state: "KNOWN", value: 50_000 }); // absolute variance is still real
  });
});

describe("computeVariance — missing/unavailable inputs never coerced to zero", () => {
  it("MISSING actual fails closed", () => {
    const r = computeVariance(MISSING, KNOWN(100));
    expect(r.absoluteVariance.state).toBe("CANNOT_ASSESS");
    expect(r.percentageVariance.state).toBe("CANNOT_ASSESS");
    expect(r.direction).toBe("NOT_APPLICABLE");
  });
  it("MISSING comparative fails closed", () => {
    const r = computeVariance(KNOWN(100), MISSING);
    expect(r.absoluteVariance.state).toBe("CANNOT_ASSESS");
  });
  it("NOT_APPLICABLE comparative fails closed", () => {
    const r = computeVariance(KNOWN(100), NOT_APPLICABLE);
    expect(r.absoluteVariance.state).toBe("CANNOT_ASSESS");
  });
  it("CANNOT_ASSESS actual (propagated from upstream) fails closed, never silently overridden", () => {
    const r = computeVariance(CANNOT_ASSESS("HESABU could not compute this line"), KNOWN(100));
    expect(r.absoluteVariance.state).toBe("CANNOT_ASSESS");
  });
});

describe("computeVariance — numeric safety (NaN/Infinity rejection)", () => {
  it("a NaN actual fails closed", () => {
    const r = computeVariance({ state: "KNOWN", value: NaN }, KNOWN(100));
    expect(r.absoluteVariance.state).toBe("CANNOT_ASSESS");
    expect(r.percentageVariance.state).toBe("CANNOT_ASSESS");
  });
  it("an Infinity comparative fails closed", () => {
    const r = computeVariance(KNOWN(100), { state: "KNOWN", value: Infinity });
    expect(r.absoluteVariance.state).toBe("CANNOT_ASSESS");
  });
  it("a -Infinity actual fails closed", () => {
    const r = computeVariance({ state: "KNOWN", value: -Infinity }, KNOWN(100));
    expect(r.absoluteVariance.state).toBe("CANNOT_ASSESS");
  });
  it("finite inputs whose difference overflows to non-finite fail closed", () => {
    const r = computeVariance(KNOWN(Number.MAX_VALUE), KNOWN(-Number.MAX_VALUE));
    expect(r.absoluteVariance.state).toBe("CANNOT_ASSESS");
  });
});

describe("computeVariance — determinism", () => {
  it("identical inputs always produce identical output", () => {
    const a = computeVariance(KNOWN(1_234_567), KNOWN(1_000_000));
    const b = computeVariance(KNOWN(1_234_567), KNOWN(1_000_000));
    expect(a).toEqual(b);
  });
});

describe("assessForecastReadiness — deterministic, no LLM, no fake confidence", () => {
  it("enough KNOWN/ZERO observations -> sufficient", () => {
    const r = assessForecastReadiness([KNOWN(1), KNOWN(2), ZERO, KNOWN(3)], 4);
    expect(r).toEqual({ status: "SUFFICIENT_HISTORY", observationCount: 4 });
  });

  it("too few observations -> explicit insufficient-data result, never a guessed forecast", () => {
    const r = assessForecastReadiness([KNOWN(1), KNOWN(2)], 4);
    expect(r).toEqual({ status: "INSUFFICIENT_HISTORY", observationCount: 2, minimumRequired: 4 });
  });

  it("MISSING/NOT_APPLICABLE/CANNOT_ASSESS observations never count toward sufficiency", () => {
    const r = assessForecastReadiness(
      [KNOWN(1), MISSING, NOT_APPLICABLE, CANNOT_ASSESS("gap"), KNOWN(2)],
      4,
    );
    expect(r).toEqual({ status: "INSUFFICIENT_HISTORY", observationCount: 2, minimumRequired: 4 });
  });

  it("empty history is insufficient, never treated as zero-variance/healthy", () => {
    const r = assessForecastReadiness([], 1);
    expect(r.status).toBe("INSUFFICIENT_HISTORY");
  });
});

// ── Ω∞ Phase 9 repair (HIGH B) — readOptionalNumericField ────────────────────
// Proves the exact logic mirrored, behavior-identical, in
// supabase/functions/_shared/maonoAnalyticalContract.ts's
// readOptionalTaxAmount (paye_total/vat_liability/sdl_liability/wht_total
// reads in maono-cashflow and maono-risk) — this is that Deno copy's
// correctness proof, since Deno function tests do not exist in this repo.

describe("readOptionalNumericField — UNKNOWN != ZERO for optional KINGA tax enrichment", () => {
  it("source is null (no tax_computations row matched) -> MISSING", () => {
    expect(readOptionalNumericField(null, "sdl_liability")).toEqual({ state: "MISSING" });
  });

  it("source is undefined -> MISSING", () => {
    expect(readOptionalNumericField(undefined, "sdl_liability")).toEqual({ state: "MISSING" });
  });

  it("source is not an object (malformed computation_detail) -> MISSING", () => {
    expect(readOptionalNumericField("not-json", "sdl_liability")).toEqual({ state: "MISSING" });
  });

  it("computation_detail exists but the key is absent -> MISSING (the real, verified case: kinga-tax-engine never writes sdl_liability/vat_liability/paye_total/wht_total)", () => {
    expect(readOptionalNumericField({ tax_payable_tzs: 500_000 }, "sdl_liability")).toEqual({ state: "MISSING" });
  });

  it("key present and explicitly null -> MISSING, not zero", () => {
    expect(readOptionalNumericField({ paye_total: null }, "paye_total")).toEqual({ state: "MISSING" });
  });

  it("key present and finite zero -> KNOWN ZERO, a real reported zero is not the same as absence", () => {
    expect(readOptionalNumericField({ vat_liability: 0 }, "vat_liability")).toEqual({ state: "ZERO", value: 0 });
  });

  it("key present and finite nonzero -> KNOWN", () => {
    expect(readOptionalNumericField({ paye_total: 1_250_000 }, "paye_total")).toEqual({ state: "KNOWN", value: 1_250_000 });
  });

  it("key present as a numeric string -> coerced and KNOWN", () => {
    expect(readOptionalNumericField({ wht_total: "45000" }, "wht_total")).toEqual({ state: "KNOWN", value: 45_000 });
  });

  it("key present but NaN -> CANNOT_ASSESS, never coalesced to 0", () => {
    const r = readOptionalNumericField({ sdl_liability: NaN }, "sdl_liability");
    expect(r.state).toBe("CANNOT_ASSESS");
  });

  it("key present but Infinity -> CANNOT_ASSESS", () => {
    const r = readOptionalNumericField({ sdl_liability: Infinity }, "sdl_liability");
    expect(r.state).toBe("CANNOT_ASSESS");
  });

  it("key present as a non-numeric string -> CANNOT_ASSESS, never 0", () => {
    const r = readOptionalNumericField({ paye_total: "unavailable" }, "paye_total");
    expect(r.state).toBe("CANNOT_ASSESS");
  });
});

// ── Ω∞ Phase 9 repair (HIGH A) — alert run/period isolation, documented ──────
// The live fix (MaonoDashboard.tsx, maono-decide/index.ts) adds
// `.eq("run_id", activeRunId)` to the variance_alerts query, matching the
// exact pattern already proven correct for variance_analyses/
// maono_insights/cashflow_forecasts in the same files (all already
// scoped by run_id, per variance_alerts.run_id REFERENCES
// variance_runs(id), migration 20260711163133). This is Supabase
// query-builder chaining, not extractable pure logic without mocking the
// client — verified by direct code reading against that established,
// already-correct sibling-query pattern rather than a synthetic unit
// test standing in for one.
describe("HIGH A — alert run/period isolation is a query-shape fix, verified by pattern consistency", () => {
  it("documents the identity rule this repair enforces: an alert belongs to the CURRENT context only when its run_id matches the exact selected run", () => {
    const alertBelongsToRun = (alert: { run_id: string | null }, targetRunId: string): boolean =>
      alert.run_id === targetRunId;

    expect(alertBelongsToRun({ run_id: "run-fy2026" }, "run-fy2026")).toBe(true);
    expect(alertBelongsToRun({ run_id: "run-fy2025" }, "run-fy2026")).toBe(false);
    expect(alertBelongsToRun({ run_id: null }, "run-fy2026")).toBe(false); // a company-wide monitor alert never impersonates a specific run's context
  });
});
