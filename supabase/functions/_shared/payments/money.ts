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

export function parseCurrencyExponent(code: string): number {
  return SUPPORTED_CURRENCIES[code] ?? 2;
}

export function moneyFromProviderDecimal(decimal: string, currency: string): bigint | null {
  const exponent = parseCurrencyExponent(currency);
  const clean = decimal.trim().replace(/,/g, '');
  const [whole, frac = ''] = clean.split('.');
  if (exponent === 0 && frac && parseInt(frac, 10) !== 0) return null; // TZS must not have frac
  const paddedFrac = frac.padEnd(exponent, '0').slice(0, exponent);
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
