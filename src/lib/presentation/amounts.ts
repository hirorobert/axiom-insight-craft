/**
 * Amount presentation for the workbench. Pure, exact (BigInt minor units in, text out).
 *
 *   zero            "0"  /  "0.00"   (never a dash: zero is a computed value)
 *   missing         "—"              (NULL means not computed; it always carries a reason for the reader)
 *   negative        "(1,234.50)"     (parentheses, never a minus sign)
 *   stale           the figure, marked stale (shown, never presented as current)
 *   reference-only  the figure, marked reference-only (never an approved comparative)
 *
 * Display rounding is not done here: values are shown at the exponent they are given in.
 */
export type AmountCell =
  | { readonly kind: "amount"; readonly minor: bigint; readonly exponent: number; readonly decimals?: number }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "stale"; readonly minor: bigint; readonly exponent: number; readonly decimals?: number; readonly reason: string }
  | { readonly kind: "reference"; readonly minor: bigint; readonly exponent: number; readonly decimals?: number };

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Exact text of an amount in minor units at `exponent`, shown with `decimals` places (default: the exponent).
 * `decimals` may only reduce places that are zero; it never rounds a value (a non-zero dropped digit is an error).
 */
export function formatMinorAmount(minor: bigint, exponent: number, decimals: number = exponent): string {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) throw new Error("exponent out of range");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > exponent) throw new Error("decimals out of range");
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const s = abs.toString().padStart(exponent + 1, "0");
  const whole = exponent === 0 ? s : s.slice(0, s.length - exponent);
  let frac = exponent === 0 ? "" : s.slice(s.length - exponent);
  const dropped = frac.slice(decimals);
  if (/[1-9]/.test(dropped)) throw new Error("display would round a non-zero digit");
  frac = frac.slice(0, decimals);
  const body = group(whole) + (frac ? `.${frac}` : "");
  return negative ? `(${body})` : body;
}

export interface AmountText {
  readonly text: string;
  /** Semantic state for styling and assistive text. */
  readonly state: "amount" | "zero" | "missing" | "stale" | "reference";
  /** Accessible description (reason for missing/stale; "reference only"). */
  readonly description: string | null;
}

export function presentAmount(cell: AmountCell): AmountText {
  switch (cell.kind) {
    case "missing":
      return { text: "—", state: "missing", description: `Not available: ${cell.reason}` };
    case "amount": {
      const text = formatMinorAmount(cell.minor, cell.exponent, cell.decimals);
      return { text, state: cell.minor === 0n ? "zero" : "amount", description: null };
    }
    case "stale":
      return { text: formatMinorAmount(cell.minor, cell.exponent, cell.decimals), state: "stale", description: `Stale: ${cell.reason}` };
    case "reference":
      return { text: formatMinorAmount(cell.minor, cell.exponent, cell.decimals), state: "reference", description: "Reference only — not an approved comparative" };
  }
}
