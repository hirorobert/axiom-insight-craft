import { ReadinessInputError, type Line, type Minor } from "./types.ts";

/** Signed minor-unit string → BigInt. Refuses anything else: there is no float and no silent zero. */
export function big(s: Minor | undefined | null, what = "amount"): bigint {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) throw new ReadinessInputError(`${what} is not a minor-unit string: ${JSON.stringify(s)}`);
  return BigInt(s);
}
export const str = (b: bigint): Minor => b.toString();
export const sum = (xs: readonly Minor[]): bigint => xs.reduce((a, x) => a + big(x), 0n);
export const abs = (s: Minor): Minor => s.replace(/^-/, "");

const DAY = 86_400_000;
export const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
export const dayDiff = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** Account → net signed amount of a set of lines (zero nets dropped). */
export function netByAccount(lines: readonly Line[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const l of lines) m.set(l.account, (m.get(l.account) ?? 0n) + big(l.amount, `line ${l.account}`));
  return m;
}
/** Canonical effect digest of a set of lines: the same economic effect always yields the same string. */
export function effectKey(lines: readonly Line[]): string {
  return [...netByAccount(lines).entries()].filter(([, v]) => v !== 0n).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}:${v}`).join("|");
}
export function sameEffect(a: readonly Line[], b: readonly Line[]): boolean { return effectKey(a) === effectKey(b); }
export function diffNets(want: Map<string, bigint>, got: Map<string, bigint>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of new Set([...want.keys(), ...got.keys()])) { const d = (want.get(k) ?? 0n) - (got.get(k) ?? 0n); if (d !== 0n) o[k] = d.toString(); }
  return o;
}
