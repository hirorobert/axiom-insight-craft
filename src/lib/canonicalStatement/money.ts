// canonicalStatement/money.ts — decimal-safe monetary arithmetic.
//
// Money is never represented as a binary floating-point `number`. Internally
// it is an integer count of minor units (bigint) at an explicit `scale`
// (decimal places) in an explicit `currency`. This makes every monetary
// value exact and every comparison deterministic — no IEEE-754 rounding
// error can ever enter an arithmetic or reconciliation result.
//
// A missing monetary fact is represented as `null` elsewhere in this module
// tree (see types.ts's MonetaryFact.value) — never as a Money of zero. A
// Money with minorUnits 0n is a genuine, reported zero; it is a distinct,
// intentional state from "not extracted."

export type CurrencyCode = string; // ISO 4217 alpha code, e.g. "TZS", "USD".

const ISO_4217_SHAPE = /^[A-Z]{3}$/;

export function isValidCurrencyCode(value: string): value is CurrencyCode {
  return ISO_4217_SHAPE.test(value);
}

export type RoundingMode = "HALF_UP" | "HALF_EVEN" | "TRUNCATE" | "CEILING" | "FLOOR";

export interface RoundingPolicy {
  readonly mode: RoundingMode;
  /** Decimal places the policy rounds to — must match the Money values it governs. */
  readonly scale: number;
}

export interface Tolerance {
  /** Absolute tolerance, expressed in minor units at the compared values' own scale. */
  readonly absoluteMinorUnits: bigint;
}

export const ZERO_TOLERANCE: Tolerance = { absoluteMinorUnits: 0n };

/**
 * A decimal-safe monetary amount: an exact integer of minor units at a
 * known scale, in a known currency. Two Money values can only be compared
 * or combined once their currency and scale are confirmed equal — see
 * `assertSameDenomination`. Mixing denominations is a structural defect
 * this module refuses to paper over with an implicit conversion.
 */
export interface Money {
  readonly currency: CurrencyCode;
  readonly scale: number;
  readonly minorUnits: bigint;
}

export class MoneyDenominationMismatchError extends Error {
  constructor(a: Money, b: Money) {
    super(
      `Cannot combine money of different denominations: ` +
        `${a.currency}@scale${a.scale} vs ${b.currency}@scale${b.scale}`,
    );
    this.name = "MoneyDenominationMismatchError";
  }
}

export function money(currency: CurrencyCode, scale: number, minorUnits: bigint): Money {
  if (!isValidCurrencyCode(currency)) {
    throw new RangeError(`Invalid ISO 4217 currency code: "${currency}"`);
  }
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`Scale must be a non-negative integer, got ${scale}`);
  }
  return { currency, scale, minorUnits };
}

const DECIMAL_STRING_SHAPE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses a plain decimal string (e.g. "1234.56", "-0.5") into exact minor
 * units at the given scale. Never routes through a binary float — the
 * string is split on the decimal point and each half is parsed as an
 * integer. Throws on any value that would lose precision at the target
 * scale (more fractional digits than the scale allows) rather than
 * silently truncating.
 */
export function moneyFromDecimalString(currency: CurrencyCode, scale: number, decimalString: string): Money {
  const match = DECIMAL_STRING_SHAPE.exec(decimalString.trim());
  if (!match) {
    throw new RangeError(`Not a plain decimal string: "${decimalString}"`);
  }
  const [, sign, wholePart, fractionalPart = ""] = match;
  if (fractionalPart.length > scale) {
    throw new RangeError(
      `"${decimalString}" has more fractional digits than scale ${scale} allows — refusing to lose precision`,
    );
  }
  const paddedFraction = fractionalPart.padEnd(scale, "0");
  const minorUnits = BigInt(wholePart + paddedFraction) * (sign === "-" ? -1n : 1n);
  return money(currency, scale, minorUnits);
}

export function assertSameDenomination(a: Money, b: Money): void {
  if (a.currency !== b.currency || a.scale !== b.scale) {
    throw new MoneyDenominationMismatchError(a, b);
  }
}

export function sameDenomination(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.scale === b.scale;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameDenomination(a, b);
  return money(a.currency, a.scale, a.minorUnits + b.minorUnits);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameDenomination(a, b);
  return money(a.currency, a.scale, a.minorUnits - b.minorUnits);
}

export function negateMoney(a: Money): Money {
  return money(a.currency, a.scale, -a.minorUnits);
}

export function isZeroMoney(a: Money): boolean {
  return a.minorUnits === 0n;
}

/**
 * Sums a non-empty list of same-denomination Money values. Returns null for
 * an empty list — an empty sum has no denomination to report and must never
 * be presented as a Money of zero (that would be indistinguishable from a
 * genuine reported zero in the caller's own currency/scale).
 */
export function sumMoney(values: readonly Money[]): Money | null {
  if (values.length === 0) return null;
  let total = values[0];
  for (let i = 1; i < values.length; i++) {
    total = addMoney(total, values[i]);
  }
  return total;
}

export type MoneyComparison = "LESS_THAN" | "EQUAL" | "GREATER_THAN";

export function compareMoney(a: Money, b: Money): MoneyComparison {
  assertSameDenomination(a, b);
  if (a.minorUnits < b.minorUnits) return "LESS_THAN";
  if (a.minorUnits > b.minorUnits) return "GREATER_THAN";
  return "EQUAL";
}

export function equalsMoney(a: Money, b: Money): boolean {
  return sameDenomination(a, b) && a.minorUnits === b.minorUnits;
}

/**
 * True if `a` and `b` are the same denomination and their absolute
 * difference is within `tolerance`. Used by casting/reconciliation rules
 * that must accept the small rounding drift a presentation-currency
 * rounding policy can legitimately introduce — never used to paper over a
 * missing value, since both `a` and `b` must already be concrete Money
 * values to call this (a null fact never reaches this function).
 */
export function equalsWithinTolerance(a: Money, b: Money, tolerance: Tolerance): boolean {
  assertSameDenomination(a, b);
  const diff = a.minorUnits - b.minorUnits;
  const absDiff = diff < 0n ? -diff : diff;
  return absDiff <= tolerance.absoluteMinorUnits;
}

/** Absolute difference, as a same-denomination Money (never negative minorUnits). */
export function absoluteDifference(a: Money, b: Money): Money {
  assertSameDenomination(a, b);
  const diff = a.minorUnits - b.minorUnits;
  return money(a.currency, a.scale, diff < 0n ? -diff : diff);
}

/** Renders exact minor units back to a plain decimal string, e.g. "1234.56". Never routes through a float. */
export function formatMoney(value: Money): string {
  const negative = value.minorUnits < 0n;
  const abs = (negative ? -value.minorUnits : value.minorUnits).toString().padStart(value.scale + 1, "0");
  const splitAt = abs.length - value.scale;
  const wholePart = abs.slice(0, splitAt) || "0";
  const fractionalPart = value.scale > 0 ? "." + abs.slice(splitAt) : "";
  return `${negative ? "-" : ""}${wholePart}${fractionalPart}`;
}
