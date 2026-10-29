/** Candidate preparation contracts. No browser/DB/provider authority. Amounts are exact minor-unit strings. */
import { z } from "zod";

export const identifier = z.string().min(1).max(160);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const minor = z.string().regex(/^(0|-?[1-9][0-9]{0,30})$/);
export const nonNegativeMinor = minor.refine(v => BigInt(v) >= 0n, "negative magnitude");
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "invalid calendar date");
export const periodSchema = z.object({ start: date, end: date }).strict().refine(p => p.start <= p.end, "reversed period");
export const scopeSchema = z.object({ companyId: identifier, period: periodSchema, currency, scale: z.number().int().min(0).max(6) }).strict();
/** Confirmation here is a claimed preparation input. A future server must retrieve and authenticate its real record. */
export const evidenceSchema = z.object({
  id: identifier, companyId: identifier, period: periodSchema, sourceRevision: hash,
  locator: z.string().min(3).max(1000), confirmedBy: identifier, confirmedAt: z.string().datetime({ offset: true }),
}).strict();
export type Scope = z.infer<typeof scopeSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

export class IpsasPreparationRefusal extends Error {
  constructor(readonly code: string) { super(code); this.name = "IpsasPreparationRefusal"; }
}
export function refuse(code: string): never { throw new IpsasPreparationRefusal(code); }
export function scopedEvidence(scope: Scope, records: readonly Evidence[]): void {
  if (!records.length) refuse("EVIDENCE_MISSING");
  const ids = new Map<string, string>();
  for (const e of records) {
    const encoding = JSON.stringify(e);
    if (ids.has(e.id) && ids.get(e.id) !== encoding) refuse("EVIDENCE_ID_REUSED");
    ids.set(e.id, encoding);
    if (e.companyId !== scope.companyId || e.period.start !== scope.period.start || e.period.end !== scope.period.end) refuse("EVIDENCE_SCOPE_MISMATCH");
  }
}
export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) refuse("INVALID_RATIO_DENOMINATOR");
  const sign = numerator < 0n ? -1n : 1n, n = numerator < 0n ? -numerator : numerator;
  return sign * ((n + denominator / 2n) / denominator);
}
export function sum(values: readonly string[]): bigint { return values.reduce((a, b) => a + BigInt(b), 0n); }
/** Bounded JSON-only source boundary; never invokes getters or silently normalises hidden/non-JSON data. */
export function jsonSnapshot(raw: unknown): unknown {
  let nodes = 0, characters = 0;
  const visit = (value: unknown, depth = 0): unknown => {
    if (++nodes > 250000 || depth > 32) refuse("SOURCE_STRUCTURE_LIMIT");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { characters += value.length; if (characters > 8000000) refuse("SOURCE_SIZE_LIMIT"); return value; }
    if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      if (value.length > 250000) refuse("SOURCE_STRUCTURE_LIMIT");
      for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !Object.hasOwn(d, "value")) refuse("SOURCE_NOT_JSON");
        out.push(visit(d.value, depth + 1));
      }
      if (Reflect.ownKeys(value).length !== value.length + 1) refuse("SOURCE_NOT_JSON");
      return out;
    }
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) refuse("SOURCE_NOT_JSON");
        const d = Object.getOwnPropertyDescriptor(value, key)!;
        if (!d.enumerable || !Object.hasOwn(d, "value")) refuse("SOURCE_NOT_JSON");
        out[key] = visit(d.value, depth + 1);
      }
      return out;
    }
    return refuse("SOURCE_NOT_JSON");
  };
  return visit(raw);
}
export function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
