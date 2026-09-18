// financialStatementsWorkspace/moneyConversion.ts — exact conversion of
// workspace-side JS `number` amounts (as persisted in
// trial_balance_uploads.processing_result JSONB, a plain-float payload) into
// canonicalStatement's decimal-safe Money. Never rounds silently: an amount
// carrying more precision than the target scale allows is rejected, not
// truncated — the caller must re-derive it at full precision, not lose it
// here.

import { money, type CurrencyCode, type Money } from "@/lib/canonicalStatement/money";

export class UnsupportedPrecisionError extends Error {
  constructor(readonly value: number, readonly scale: number) {
    super(`Amount ${value} carries more precision than scale ${scale} supports — refusing to round`);
    this.name = "UnsupportedPrecisionError";
  }
}

export class UnsafeMagnitudeError extends Error {
  constructor(readonly value: number, readonly scale: number) {
    super(`Amount ${value} at scale ${scale} exceeds the safe-integer range for exact minor-unit conversion`);
    this.name = "UnsafeMagnitudeError";
  }
}

/**
 * IEEE-754 representation drift tolerance only (e.g. 10.1 stored as
 * 10.099999999999998) — never large enough to absorb genuine sub-scale
 * precision (e.g. 10.125 at scale 2, which must still be rejected).
 */
const FLOAT_DRIFT_TOLERANCE = 1e-6;

/**
 * Converts a plain JS `number` to an exact Money at the given
 * currency/scale. Rejects non-finite input, rejects any value whose true
 * decimal precision exceeds `scale`, and rejects a magnitude too large to
 * convert exactly within IEEE-754's safe-integer range.
 */
export function numberToMoneyExact(value: number, currency: CurrencyCode, scale: number): Money {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Amount must be a finite number, got ${value}`);
  }
  const factor = 10 ** scale;
  const scaled = value * factor;
  if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    throw new UnsafeMagnitudeError(value, scale);
  }
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > FLOAT_DRIFT_TOLERANCE) {
    throw new UnsupportedPrecisionError(value, scale);
  }
  return money(currency, scale, BigInt(rounded));
}
