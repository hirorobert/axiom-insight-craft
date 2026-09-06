/**
 * Ω2 — Edge Function money utilities (Deno-compatible, no BigInt serialisation issues).
 * Mirrors src/lib/commercial/payments/money.ts for server-side use.
 * NEVER use JavaScript number for authoritative money comparison.
 */

export const TZS_EXPONENT = 0;
export const SUPPORTED_CURRENCIES: Record<string, number> = {
  TZS: 0, USD: 2, KES: 2, UGX: 0, GBP: 2, EUR: 2,
};

export interface MinorAmount {
  amountMinor: bigint;
  currencyCode: string;
  exponent: number;
}

/**
 * Fail-closed exponent lookup. An unrecognised currency returns null — it
 * NEVER defaults to 2. A silent default would let an unsupported currency's
 * decimal be misinterpreted at the wrong precision.
 */
export function parseCurrencyExponent(code: string): number | null {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, code)
    ? SUPPORTED_CURRENCIES[code]
    : null;
}

/**
 * Strict decimal shape: optional leading digits, optional '.' + digits.
 * No sign (negative amounts are rejected outright), no scientific notation,
 * no thousands separators (stripped before this test), nothing else.
 */
const STRICT_DECIMAL_SHAPE = /^\d+(\.\d+)?$/;

/**
 * Ω2-GR1 money-authority exactness repair (BLOCKER-1).
 *
 * A provider decimal amount must be EXACTLY representable at the currency's
 * declared exponent. Excess fractional digits beyond the exponent are
 * accepted ONLY when every excess digit is zero (e.g. "1.230" for USD is
 * exactly "1.23"). Any non-zero excess digit means the provider is reporting
 * a smaller unit than SAFF's authoritative currency table supports — the
 * amount is REJECTED, never rounded or truncated. Never uses floating-point
 * multiplication/parseFloat as authority; only string-level decimal
 * arithmetic feeding an exact BigInt conversion.
 */
export function moneyFromProviderDecimal(decimal: string, currency: string): bigint | null {
  const exponent = parseCurrencyExponent(currency);
  if (exponent === null) return null; // unsupported currency: fail closed

  const clean = decimal.trim().replace(/,/g, '');
  if (!STRICT_DECIMAL_SHAPE.test(clean)) return null; // rejects negative, scientific notation, NaN, Infinity, garbage

  const [whole, frac = ''] = clean.split('.');

  if (frac.length > exponent) {
    const excess = frac.slice(exponent);
    if (!/^0*$/.test(excess)) return null; // non-zero excess precision — ZERO truncation, reject
  }

  const paddedFrac = frac.slice(0, exponent).padEnd(exponent, '0');
  try { return BigInt(`${whole}${paddedFrac}`); } catch { return null; }
}

export function moneyEquals(a: bigint, aCurrency: string, b: bigint, bCurrency: string): boolean {
  return aCurrency === bCurrency && a === b;
}

export function formatMinorForProvider(amountMinor: bigint, exponent: number): string {
  if (exponent === 0) return amountMinor.toString();
  const divisor = BigInt(10 ** exponent);
  const whole = amountMinor / divisor;
  const frac = amountMinor % divisor;
  return `${whole}.${frac.toString().padStart(exponent, '0')}`;
}
