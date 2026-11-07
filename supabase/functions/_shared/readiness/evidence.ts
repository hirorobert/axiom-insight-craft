import { abs } from "./money.ts";
import type { Evidence } from "./types.ts";

/**
 * What a rule needs a document to STATE. Evidence is probative for a rule only when
 *   (1) its facts are human-confirmed or reproduced against an independent control, AND
 *   (2) every fact the rule depends on is PRESENT and equal.
 * An absent fact never passes. Confirmation and extraction status make facts admissible; they never make them relevant.
 */
export interface EvidenceNeed {
  kind?: string | string[];
  /** Any-of for account (a line may sit in several ledger accounts). */
  account?: string | string[];
  ref?: string | string[]; counterparty?: string | string[];
  /** Exact signed amount. */
  amount?: string;
  /** Amount compared without sign. */
  amount_abs?: string;
  date?: string;
  /** Inclusive window; REQUIRES the document to state a date. */
  within?: [string, string];
  /** Facts that must merely be stated. */
  present?: string[];
}
export type Probative = { ok: true } | { ok: false; why: string };

const stated = (v: string | undefined | null): v is string => v !== undefined && v !== null && v !== "";
const anyOf = (x: string | string[]) => (Array.isArray(x) ? x : [x]);

export function probative(ev: Evidence | undefined, need: EvidenceNeed = {}): Probative {
  if (!ev) return { ok: false, why: "absent" };
  if (ev.extraction !== "human_confirmed" && ev.extraction !== "reproduced") return { ok: false, why: "extraction_unconfirmed" };
  if (need.kind && !anyOf(need.kind).includes(ev.kind)) return { ok: false, why: "wrong_kind" };
  const f = ev.facts ?? {};
  for (const k of ["amount", "ref", "counterparty", "account", "date"] as const) {
    const want = need[k];
    if (want === undefined) continue;
    const got = f[k];
    if (!stated(got)) return { ok: false, why: `missing_fact:${k}` };
    if (!anyOf(want).includes(got)) return { ok: false, why: `fact_mismatch:${k}` };
  }
  if (need.amount_abs !== undefined) {
    if (!stated(f.amount)) return { ok: false, why: "missing_fact:amount" };
    if (abs(f.amount) !== need.amount_abs) return { ok: false, why: "fact_mismatch:amount" };
  }
  for (const k of need.present ?? []) if (!stated(f[k])) return { ok: false, why: `missing_fact:${k}` };
  if (need.within) {
    if (!stated(f.date)) return { ok: false, why: "missing_fact:date" };
    if (f.date < need.within[0] || f.date > need.within[1]) return { ok: false, why: "outside_window" };
  }
  return { ok: true };
}
