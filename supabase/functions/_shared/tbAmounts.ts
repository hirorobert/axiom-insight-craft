/**
 * _shared/tbAmounts.ts — the exact amounts of an accepted trial balance (E1, contract "tb-amounts/1").
 *
 * Every figure is an integer number of the currency's minor units, carried as a BigInt and written as a decimal string
 * matching ^(0|-?[1-9][0-9]*)$ (no "-0", no leading zeros, no sign "+", no point, no exponent). Values are unbounded;
 * Number is never used for a figure here.
 *
 * Signs (docs/release/R0_CONTRACT_CORRECTIONS.md §3):
 *   - source.difference = debit total − credit total;
 *   - class figures are class-side: assets and expenses debit − credit; liabilities, equity and income credit − debit.
 *     normal_balance only marks contra behaviour; it never re-signs a class (a contra asset reduces assets);
 *   - equation.lhs = assets; equation.rhs = liabilities + equity + income − expenses; equation.difference = lhs − rhs;
 *     status is "balanced" if and only if the difference is 0;
 *   - cash (C2), with b = debit − credit per cash account, every cash account classified as an asset or a liability:
 *       reported        = Σ b over asset-classified cash accounts;
 *       overdraft       = Σ (−b) over liability-classified cash accounts;
 *       net_position    = Σ b over all cash accounts (so net_position = reported − overdraft);
 *       credit_balances = Σ (−b) over cash accounts with b < 0 (so ≥ 0);
 *       accounts        = the number of cash accounts.
 *   - reconciliation.status is "not_checked": the trial balance alone never proves cash against a bank.
 *
 * validateTbAmounts() checks the grammar AND recomputes every relationship from the values themselves. A grammatically
 * valid document with inconsistent figures is malformed, and malformed means "result unavailable", never a pass.
 * The browser keeps its own copy of the validator (no cross-import exists between src/ and supabase/functions/).
 */
import { CURRENCY_EXPONENTS } from "./tbIngestion.ts";

export const TB_AMOUNTS_CONTRACT = "tb-amounts/1";
export const TB_ROW_CONTRACT = "tb-row/1";

export type ClassSide = "assets" | "liabilities" | "equity" | "income" | "expenses";

const CLASS_SIDE: Readonly<Record<string, ClassSide>> = Object.freeze({
  current_assets: "assets",
  non_current_assets: "assets",
  current_liabilities: "liabilities",
  non_current_liabilities: "liabilities",
  equity: "equity",
  revenue: "income",
  other_income: "income",
  cost_of_goods_sold: "expenses",
  operating_expenses: "expenses",
  taxes: "expenses",
});

/** The class side of a balance-sheet or income-statement classification; null for anything else (cash-flow classes). */
export function classSideOf(classification: string): ClassSide | null {
  return Object.prototype.hasOwnProperty.call(CLASS_SIDE, classification) ? CLASS_SIDE[classification] : null;
}

/** The class-side amount: debit-positive for assets and expenses, credit-positive for liabilities, equity and income. */
export function classSideMinor(side: ClassSide, debitMinor: bigint, creditMinor: bigint): bigint {
  return side === "assets" || side === "expenses" ? debitMinor - creditMinor : creditMinor - debitMinor;
}

const MINOR = /^(0|-?[1-9][0-9]*)$/;

export function isMinorString(v: unknown): v is string {
  return typeof v === "string" && MINOR.test(v);
}

export function minorString(v: bigint): string {
  return v.toString();
}

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

export interface AmountsAccount {
  classification: string;
  isCash: boolean;
  debitMinor: bigint;
  creditMinor: bigint;
}

export interface AmountsInput {
  currency: string;
  exponent: number;
  debitTotalMinor: bigint;
  creditTotalMinor: bigint;
  /** The accounts included in the statements (every one on a balance-sheet or income-statement classification). */
  accounts: AmountsAccount[];
}

/**
 * Builds the document from exact amounts. Throws on an account outside the balance sheet and income statement, or a cash
 * account that is neither an asset nor a liability: those must have gone to review before any amounts are built.
 */
export function buildTbAmounts(input: AmountsInput): TbAmounts {
  const sums: Record<ClassSide, bigint> = { assets: 0n, liabilities: 0n, equity: 0n, income: 0n, expenses: 0n };
  let reported = 0n, overdraft = 0n, net = 0n, creditBalances = 0n, cashAccounts = 0;
  for (const a of input.accounts) {
    const side = classSideOf(a.classification);
    if (!side) throw new Error(`tb-amounts: classification "${a.classification}" is not on the balance sheet or income statement`);
    sums[side] += classSideMinor(side, a.debitMinor, a.creditMinor);
    if (a.isCash) {
      if (side !== "assets" && side !== "liabilities") throw new Error("tb-amounts: a cash account must be an asset or a liability");
      const b = a.debitMinor - a.creditMinor;
      if (side === "assets") reported += b; else overdraft += -b;
      net += b;
      if (b < 0n) creditBalances += -b;
      cashAccounts++;
    }
  }
  const lhs = sums.assets;
  const rhs = sums.liabilities + sums.equity + sums.income - sums.expenses;
  const diff = lhs - rhs;
  return {
    contract: TB_AMOUNTS_CONTRACT,
    currency: input.currency,
    exponent: input.exponent,
    source: {
      debit_total_minor: minorString(input.debitTotalMinor),
      credit_total_minor: minorString(input.creditTotalMinor),
      difference_minor: minorString(input.debitTotalMinor - input.creditTotalMinor),
    },
    classes: {
      assets_minor: minorString(sums.assets),
      liabilities_minor: minorString(sums.liabilities),
      equity_minor: minorString(sums.equity),
      income_minor: minorString(sums.income),
      expenses_minor: minorString(sums.expenses),
    },
    equation: { lhs_minor: minorString(lhs), rhs_minor: minorString(rhs), difference_minor: minorString(diff), status: diff === 0n ? "balanced" : "failed" },
    cash: {
      reported_minor: minorString(reported),
      credit_balances_minor: minorString(creditBalances),
      overdraft_minor: minorString(overdraft),
      net_position_minor: minorString(net),
      accounts: cashAccounts,
    },
    reconciliation: { status: "not_checked" },
  };
}

export type TbAmountsValidation = { ok: true; value: TbAmounts } | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

/** Grammar, then every relationship recomputed from the values. Any failure is malformed. */
export function validateTbAmounts(doc: unknown): TbAmountsValidation {
  const bad = (reason: string): TbAmountsValidation => ({ ok: false, reason });
  if (!isPlainObject(doc)) return bad("not an object");
  if (!exactKeys(doc, ["contract", "currency", "exponent", "source", "classes", "equation", "cash", "reconciliation"])) return bad("keys");
  if (doc.contract !== TB_AMOUNTS_CONTRACT) return bad("contract");
  if (typeof doc.currency !== "string" || !Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, doc.currency)) return bad("currency");
  if (doc.exponent !== CURRENCY_EXPONENTS[doc.currency]) return bad("exponent");

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
  if (!minors.every(isMinorString)) return bad("grammar");
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
