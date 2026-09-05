/**
 * Ω2 — Authoritative money representation for SAFF commercial layer.
 *
 * Iron Dome law: JavaScript floating-point is NEVER authoritative money.
 * All commercial amounts are stored and compared as integer minor units.
 *
 * TZS: exponent=0 (no fractional shillings). 1 TZS = 1 minor unit.
 * USD: exponent=2. $1.00 = 100 minor units.
 *
 * This module is presentation + validation only. It never decides
 * entitlement, never writes to the DB, and never contacts a provider.
 */

export const SUPPORTED_CURRENCIES = ['TZS', 'USD', 'KES', 'UGX', 'GBP', 'EUR'] as const;
export type CurrencyCode = typeof SUPPORTED_CURRENCIES[number];

/**
 * ISO 4217 exponents for supported currencies. Adding a currency (e.g. for
 * a future UK/EU offer) is exactly this: one array entry + one exponent —
 * no schema change, no core redesign. Currency belongs to the offer, never
 * to the plan (see commercial_offers in the Ω2-G migration).
 */
export const CURRENCY_EXPONENTS: Record<CurrencyCode, number> = {
  TZS: 0,  // no fractional shillings
  USD: 2,
  KES: 2,
  UGX: 0,
  GBP: 2,
  EUR: 2,
};

/** Maximum safe BIGINT minor units that Postgres BIGINT can hold */
const MAX_SAFE_MINOR_UNITS = BigInt('9223372036854775807');

export interface Money {
  readonly amountMinor: bigint;
  readonly currencyCode: CurrencyCode;
  readonly exponent: number;
}

export type MoneyValidationResult =
  | { valid: true; money: Money }
  | { valid: false; error: string };

/**
 * Create a Money value from integer minor units.
 * Returns a validation result — never throws for invalid input.
 *
 * Hostile-input contract (Ω2-G money authority repair): every branch below
 * that could otherwise reach `BigInt(amountMinor)` with a value BigInt()
 * itself would throw on (a non-integer number, NaN, +/-Infinity) is
 * rejected BEFORE that call. A `number` is additionally rejected outside
 * Number.isSafeInteger() range, since a number that large has already lost
 * precision before it ever reaches this function — accepting it would
 * silently authorise a corrupted amount. `bigint` inputs are exact by
 * construction and only need the currency/positivity/overflow checks.
 */
export function moneyFromMinorUnits(
  amountMinor: bigint | number,
  currencyCode: string,
): MoneyValidationResult {
  if (!SUPPORTED_CURRENCIES.includes(currencyCode as CurrencyCode)) {
    return { valid: false, error: `Unsupported currency: ${currencyCode}` };
  }

  if (typeof amountMinor === 'number') {
    if (!Number.isFinite(amountMinor)) {
      return { valid: false, error: `Amount must be finite. Got: ${amountMinor}` };
    }
    if (!Number.isInteger(amountMinor)) {
      return { valid: false, error: `Amount must be an integer (no fractional minor units). Got: ${amountMinor}` };
    }
    if (!Number.isSafeInteger(amountMinor)) {
      return { valid: false, error: `Amount exceeds safe integer precision: ${amountMinor}` };
    }
  }

  let minor: bigint;
  try {
    minor = BigInt(amountMinor);
  } catch {
    // Defence in depth — the checks above should make this unreachable for
    // `number`, and a `bigint` input can never throw in BigInt(), but a
    // validation function that documents "never throws" must not rely on
    // that being true forever.
    return { valid: false, error: `Amount could not be converted to an integer: ${String(amountMinor)}` };
  }

  if (minor <= BigInt(0)) {
    return { valid: false, error: `Amount must be positive. Got: ${minor}` };
  }
  if (minor > MAX_SAFE_MINOR_UNITS) {
    return { valid: false, error: `Amount overflows BIGINT: ${minor}` };
  }
  const code = currencyCode as CurrencyCode;
  return {
    valid: true,
    money: { amountMinor: minor, currencyCode: code, exponent: CURRENCY_EXPONENTS[code] },
  };
}

/**
 * Convert Money to display string. Never use for comparison — always compare
 * amountMinor directly.
 */
export function moneyToDisplay(money: Money): string {
  if (money.exponent === 0) {
    return `${money.currencyCode} ${money.amountMinor.toString()}`;
  }
  const divisor = BigInt(10 ** money.exponent);
  const whole = money.amountMinor / divisor;
  const frac = money.amountMinor % divisor;
  return `${money.currencyCode} ${whole}.${frac.toString().padStart(money.exponent, '0')}`;
}

/**
 * Compare two Money values for equality. Both currency AND amount must match.
 * Returns false (not throws) if currencies differ — caller must handle mismatch.
 */
export function moneyEquals(a: Money, b: Money): boolean {
  return a.currencyCode === b.currencyCode && a.amountMinor === b.amountMinor;
}

/**
 * Safe conversion from a provider's decimal string (e.g. "450000.00" for TZS)
 * to authoritative minor units. Validates that the fractional part is consistent
 * with the currency's exponent (TZS should never have non-zero fractional part).
 */
export function moneyFromProviderDecimal(
  decimalString: string,
  currencyCode: string,
): MoneyValidationResult {
  if (!SUPPORTED_CURRENCIES.includes(currencyCode as CurrencyCode)) {
    return { valid: false, error: `Unsupported currency: ${currencyCode}` };
  }
  const code = currencyCode as CurrencyCode;
  const exponent = CURRENCY_EXPONENTS[code];

  const cleaned = decimalString.trim().replace(/,/g, '');
  const parts = cleaned.split('.');
  if (parts.length > 2) {
    return { valid: false, error: `Invalid decimal: ${decimalString}` };
  }

  const wholePart = parts[0];
  const fracPart = parts[1] ?? '';

  if (exponent === 0 && fracPart && parseInt(fracPart, 10) !== 0) {
    return {
      valid: false,
      error: `${code} has exponent=0 but provider sent fractional: ${decimalString}`,
    };
  }

  const paddedFrac = fracPart.padEnd(exponent, '0').slice(0, exponent);
  const combined = `${wholePart}${paddedFrac}`;

  try {
    return moneyFromMinorUnits(BigInt(combined), currencyCode);
  } catch {
    return { valid: false, error: `Cannot parse decimal as integer: ${decimalString}` };
  }
}

/**
 * Guard: assert a provider-reported amount matches SAFF's expected amount.
 * Returns true only when currency AND minor units exactly match.
 * Used by webhook verification — a mismatch is a hard rejection.
 */
export function moneyMatchesExpected(
  reportedMinor: bigint,
  reportedCurrency: string,
  expectedMoney: Money,
): boolean {
  if (reportedCurrency !== expectedMoney.currencyCode) return false;
  return reportedMinor === expectedMoney.amountMinor;
}
