import { IntakeError } from "./errors";

/**
 * Exact money from the text of a cell. No floating point anywhere. Thousands separators are accepted only in correct
 * places; more decimals than the currency has are refused (never rounded); a sign is accepted only where the caller allows it.
 */
const PLAIN = /^\d+(\.\d+)?$/;
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

export interface Where { file: string; line: number; column: number }

export function parseMinor(cell: string, exponent: number, where: Where, what: string, opts: { signed?: boolean; blank?: "zero" | "refuse" } = {}): bigint {
  let s = cell.trim();
  if (s === "") {
    if (opts.blank === "refuse") throw new IntakeError(`${what} is empty`, where.file, where.line, where.column);
    return 0n;
  }
  let neg = false;
  if (s.startsWith("-")) {
    if (!opts.signed) throw new IntakeError(`${what} "${cell}" is negative; put it in the other column`, where.file, where.line, where.column);
    neg = true; s = s.slice(1);
  }
  if (!(PLAIN.test(s) || GROUPED.test(s))) throw new IntakeError(`${what} "${cell}" is not a plain decimal amount`, where.file, where.line, where.column);
  const [whole, frac = ""] = s.replace(/,/g, "").split(".");
  if (frac.length > exponent) throw new IntakeError(`${what} "${cell}" has more than ${exponent} decimal places`, where.file, where.line, where.column);
  const v = BigInt(whole + frac.padEnd(exponent, "0"));
  return neg ? -v : v;
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d >= 1 && d <= (mo === 2 && leap ? 29 : DAYS[mo - 1]);
}

/** Minor units → "33518793.00" (plain, no separators): the form the committed exports use. */
export function plainMinor(v: bigint, exponent: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(exponent + 1, "0");
  const body = exponent === 0 ? s : `${s.slice(0, s.length - exponent)}.${s.slice(s.length - exponent)}`;
  return neg ? `-${body}` : body;
}
