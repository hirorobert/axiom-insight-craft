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
  isAuthoritativeAccountingFact,
  fromComparativeAmount,
  fromHesabuResult,
  isStaleContext,
  computeVariance,
  assessForecastReadiness,
  type AnalyticalValue,
  type AnalyticalContext,
  type AnalyticalResultType,
} from "./maonoAnalyticalContract";
import type { ComparativeAmount } from "./comparativeEvidence";

const KNOWN = (value: number): AnalyticalValue => ({ state: "KNOWN", value });
const ZERO: AnalyticalValue = { state: "ZERO", value: 0 };
const MISSING: AnalyticalValue = { state: "MISSING" };
const NOT_APPLICABLE: AnalyticalValue = { state: "NOT_APPLICABLE" };
const CANNOT_ASSESS = (reason: string): AnalyticalValue => ({ state: "CANNOT_ASSESS", reason });

describe("isAuthoritativeAccountingFact — analytics never masquerades as accounting authority", () => {
  it("only OBSERVED_FACT is authoritative", () => {
    expect(isAuthoritativeAccountingFact("OBSERVED_FACT")).toBe(true);
  });

  it.each<AnalyticalResultType>([
    "DERIVED_METRIC", "VARIANCE", "TREND", "FORECAST", "RISK_SIGNAL", "HYPOTHESIS", "RECOMMENDATION",
  ])("%s is never authoritative", (resultType) => {
    expect(isAuthoritativeAccountingFact(resultType)).toBe(false);
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
