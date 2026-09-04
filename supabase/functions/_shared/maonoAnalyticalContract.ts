/**
 * _shared/maonoAnalyticalContract.ts — Ω∞ Phase 9 repair-forward.
 *
 * Deno-runtime mirror of the browser-side, fully-tested
 * src/lib/accounting/maonoAnalyticalContract.ts's numeric-safety core.
 * Deno edge functions in this repo cannot import across the src/ bundling
 * boundary, so this is a deliberate, minimal, behavior-identical copy —
 * not a redesign, not a competing contract. Keep the two files' variance
 * logic in sync; the browser file's 30+ vitest cases are the source of
 * truth for correctness (this file has no test harness of its own — Deno
 * function tests are not present in this repository).
 *
 * Scope is intentionally narrow: only the primitives existing live call
 * sites (maono-compute's variancePct(); maono-risk's and maono-cashflow's
 * optional tax-figure reads) needed to adopt this pass, not the full
 * contract (AnalyticalResultType, provenance, trust assessment stay
 * browser-side pure contracts for now — see maonoAnalyticalContract.ts's
 * own docstring on why untested Deno writes are not blindly expanded).
 */

export type AnalyticalValue =
  | { state: "KNOWN"; value: number }
  | { state: "ZERO"; value: 0 }
  | { state: "MISSING" }
  | { state: "NOT_APPLICABLE" }
  | { state: "CANNOT_ASSESS"; reason: string };

export type VarianceDirection = "FAVORABLE" | "UNFAVORABLE" | "NEUTRAL" | "NOT_APPLICABLE";

export interface VarianceResult {
  absoluteVariance: AnalyticalValue;
  percentageVariance: AnalyticalValue;
  direction: VarianceDirection;
}

function numericValueOf(v: AnalyticalValue): number | null {
  if (v.state === "KNOWN") return v.value;
  if (v.state === "ZERO") return 0;
  return null;
}

/** Behavior-identical to maonoAnalyticalContract.ts's computeVariance — see that file for the full test matrix this logic is proven against. */
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

/**
 * Ω∞ Phase 9 repair (HIGH B — UNKNOWN != ZERO for optional KINGA
 * enrichment): reads one numeric field out of an arbitrary JSONB payload
 * (e.g. tax_computations.computation_detail) without ever coalescing an
 * absent or malformed key to 0. `null` means unavailable (key missing,
 * source itself missing/not an object, or value not finite) — the caller
 * must treat that as "no data," never as a known zero liability. Behavior
 * mirrored and proven in src/lib/accounting/maonoAnalyticalContract.test.ts
 * via readOptionalNumericField (same logic, richer AnalyticalValue return
 * type) — this Deno copy has no test harness of its own.
 */
export function readOptionalTaxAmount(source: unknown, key: string): number | null {
  if (source === null || typeof source !== "object") return null;
  const v = (source as Record<string, unknown>)[key];
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
