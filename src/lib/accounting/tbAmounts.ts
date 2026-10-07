/**
 * tbAmounts — the browser reader of the exact trial-balance amounts the engine records ("tb-amounts/1", written by
 * process-trial-balance since E1 as processing_result.amounts).
 *
 * The engine's copy is supabase/functions/_shared/tbAmounts.ts; there is no cross-import between src/ and
 * supabase/functions/, so this is a separate copy, kept identical in behaviour by tbAmounts.parity.test.ts (the same
 * corpus through both validators, and the same currency table).
 *
 * Every figure is a decimal string of minor units (^(0|-?[1-9][0-9]*)$). It is read with BigInt and formatted from the
 * string; Number is never used to display or compare a figure. validateTbAmounts checks the grammar AND recomputes every
 * relationship (source difference, equation sides, difference, status if and only if zero, net cash = reported −
 * overdraft, credit balances ≥ 0, no cash figures without cash accounts). Malformed means "result unavailable", never a
 * pass. A result without `amounts` is legacy: shown conservatively, and its floats are never converted into this contract.
 */

import { CURRENCY_REGISTRY } from "@/lib/currency/registry";

export const TB_AMOUNTS_CONTRACT = "tb-amounts/1";

/** ISO 4217 exponents — currency-registry/1, identical to the engine's table (supabase/functions/_shared/currencyRegistry.ts; parity-tested). */
export const TB_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = CURRENCY_REGISTRY;

export interface TbAmounts {
  contract: "tb-amounts/1";
  currency: string;
  exponent: number;
  source: { debit_total_minor: string; credit_total_minor: string; difference_minor: string };
  classes: { assets_minor: string; liabilities_minor: string; equity_minor: string; income_minor: string; expenses_minor: string };
  equation: { lhs_minor: string; rhs_minor: string; difference_minor: string; status: "balanced" | "failed" };
  cash: { reported_minor: string; credit_balances_minor: string; overdraft_minor: string; net_position_minor: string; accounts: number };
  reconciliation: { status: "not_checked" };
}

export type TbAmountsValidation = { ok: true; value: TbAmounts } | { ok: false; reason: string };

const MINOR = /^(0|-?[1-9][0-9]*)$/;
const isMinor = (v: unknown): v is string => typeof v === "string" && MINOR.test(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => has(o, k));

/** Grammar, then every relationship recomputed from the values. Any failure is malformed. */
export function validateTbAmounts(doc: unknown): TbAmountsValidation {
  const bad = (reason: string): TbAmountsValidation => ({ ok: false, reason });
  if (!isPlainObject(doc)) return bad("not an object");
  if (!exactKeys(doc, ["contract", "currency", "exponent", "source", "classes", "equation", "cash", "reconciliation"])) return bad("keys");
  if (doc.contract !== TB_AMOUNTS_CONTRACT) return bad("contract");
  if (typeof doc.currency !== "string" || !has(TB_CURRENCY_EXPONENTS, doc.currency)) return bad("currency");
  if (doc.exponent !== TB_CURRENCY_EXPONENTS[doc.currency]) return bad("exponent");

  const { source, classes, equation, cash, reconciliation } = doc;
  if (!isPlainObject(source) || !exactKeys(source, ["debit_total_minor", "credit_total_minor", "difference_minor"])) return bad("source keys");
  if (!isPlainObject(classes) || !exactKeys(classes, ["assets_minor", "liabilities_minor", "equity_minor", "income_minor", "expenses_minor"])) return bad("classes keys");
  if (!isPlainObject(equation) || !exactKeys(equation, ["lhs_minor", "rhs_minor", "difference_minor", "status"])) return bad("equation keys");
  if (!isPlainObject(cash) || !exactKeys(cash, ["reported_minor", "credit_balances_minor", "overdraft_minor", "net_position_minor", "accounts"])) return bad("cash keys");
  if (!isPlainObject(reconciliation) || !exactKeys(reconciliation, ["status"]) || reconciliation.status !== "not_checked") return bad("reconciliation");

  const minors = [
    ...Object.values(source), ...Object.values(classes),
    equation.lhs_minor, equation.rhs_minor, equation.difference_minor,
    cash.reported_minor, cash.credit_balances_minor, cash.overdraft_minor, cash.net_position_minor,
  ];
  if (!minors.every(isMinor)) return bad("grammar");
  if (equation.status !== "balanced" && equation.status !== "failed") return bad("equation status");
  if (typeof cash.accounts !== "number" || !Number.isSafeInteger(cash.accounts) || cash.accounts < 0) return bad("cash accounts");

  const n = (v: unknown) => BigInt(v as string);
  if (n(source.difference_minor) !== n(source.debit_total_minor) - n(source.credit_total_minor)) return bad("source difference");
  if (n(source.debit_total_minor) < 0n || n(source.credit_total_minor) < 0n) return bad("source totals negative");
  if (n(equation.lhs_minor) !== n(classes.assets_minor)) return bad("equation lhs");
  if (n(equation.rhs_minor) !== n(classes.liabilities_minor) + n(classes.equity_minor) + n(classes.income_minor) - n(classes.expenses_minor)) return bad("equation rhs");
  const diff = n(equation.lhs_minor) - n(equation.rhs_minor);
  if (n(equation.difference_minor) !== diff) return bad("equation difference");
  if ((equation.status === "balanced") !== (diff === 0n)) return bad("equation status mismatch");
  if (n(cash.net_position_minor) !== n(cash.reported_minor) - n(cash.overdraft_minor)) return bad("cash net position");
  if (n(cash.credit_balances_minor) < 0n) return bad("cash credit balances negative");
  if (cash.accounts === 0 && [cash.reported_minor, cash.credit_balances_minor, cash.overdraft_minor, cash.net_position_minor].some((v) => n(v) !== 0n)) {
    return bad("cash figures without cash accounts");
  }
  return { ok: true, value: doc as unknown as TbAmounts };
}

/**
 * Exact decimal text of a minor-unit string at the exponent, with thousands separators: formatMinorString("-123456", 2)
 * === "-1,234.56". BigInt only — exact at any size (beyond 2^53 included).
 */
export function formatMinorString(minor: string, exponent: number): string {
  if (!isMinor(minor)) throw new Error("formatMinorString: not a minor-unit string");
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) throw new Error("formatMinorString: exponent out of range");
  const v = BigInt(minor);
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString().padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, digits.length - exponent);
  const frac = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac}`;
}

/**
 * What the stored result says about its exact amounts:
 *   absent     no `amounts` (a legacy result, from an engine before E1): shown conservatively, never as exact;
 *   malformed  `amounts` present but not a valid tb-amounts/1 document: result unavailable, never a pass;
 *   exact      a valid document (its equation may be balanced or failed).
 */
export type RecordedAmounts = { state: "absent" } | { state: "malformed"; reason: string } | { state: "exact"; amounts: TbAmounts };

export function readRecordedAmounts(processingResult: unknown): RecordedAmounts {
  if (!isPlainObject(processingResult) || !has(processingResult, "amounts") || processingResult.amounts === undefined) return { state: "absent" };
  const v = validateTbAmounts(processingResult.amounts);
  if (v.ok === true) return { state: "exact", amounts: v.value };
  return { state: "malformed", reason: (v as { ok: false; reason: string }).reason };
}
