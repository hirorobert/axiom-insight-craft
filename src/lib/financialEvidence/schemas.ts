// financialEvidence/schemas.ts — the column contract for each evidence family.
//
// A schema states which columns exist, which are required, and how each cell is
// validated. It never supplies a default: a blank optional cell stays blank
// (absent), and a blank required cell is an ERROR. Cross-row rules (unique keys,
// one-of-two amounts, single opening/closing balance) live beside the columns.

import { EVIDENCE_SCHEMA_VERSION, LEDGER_TRANSFER_SCHEMA_VERSION, type EvidenceDiagnostic, type EvidenceType } from "./types";

export type CellKind = "DECIMAL" | "DATE" | "TEXT" | "LONGTEXT" | "KEY" | "CODE" | "YESNO" | { readonly oneOf: readonly string[] };

export interface ColumnSpec {
  readonly name: string;
  readonly kind: CellKind;
  readonly required: boolean;
}

export interface RowAccess {
  readonly count: number;
  /** Raw cell text of data row `index` (0-based) for column `name`; "" when the column is absent from the file. */
  cell(index: number, name: string): string;
}

export interface FamilySchema {
  readonly columns: readonly ColumnSpec[];
  /** True when at least one column is a DECIMAL, so currency and scale are mandatory. */
  readonly hasAmounts: boolean;
  /** Cross-row diagnostics run only after every cell has validated. */
  readonly crossRow?: (rows: RowAccess, ctx: { periodStart?: string; periodEnd?: string }) => readonly EvidenceDiagnostic[];
}

const req = (name: string, kind: CellKind): ColumnSpec => ({ name, kind, required: true });
const opt = (name: string, kind: CellKind): ColumnSpec => ({ name, kind, required: false });

const err = (code: string, message: string, row?: number, column?: string, value?: string): EvidenceDiagnostic => ({ code, severity: "ERROR", message, row, column, value });
const warn = (code: string, message: string, row?: number, column?: string, value?: string): EvidenceDiagnostic => ({ code, severity: "WARNING", message, row, column, value });

export const ACTIVITIES = ["OPERATING", "INVESTING", "FINANCING"] as const;
/**
 * Ledger schema 1.1.0 (S2-A01): a movement between two cash accounts of the perimeter (bank → petty cash) is not a cash flow
 * (IFRS for SMEs, 2015 edition, Section 7 Statement of Cash Flows, presents inflows and outflows of cash and cash equivalents; a
 * movement between two of them is neither — IAS 7 paragraph 9 states the exclusion explicitly. Paragraph-level citations
 * unverified: the pinned 2015 text is referenced by hash in docs/reporting/IFRS_FOR_SMES_PACK.md, not held in this repository.)
 * Both legs stay in the ledger, because the per-account roll-forward needs every movement of every cash account,
 * and each names the other account in counter_cash_account_code. The direct-method statement leaves them out of every line.
 */
export const TRANSFER_ACTIVITY = "TRANSFER_BETWEEN_CASH_ACCOUNTS" as const;
export const LEDGER_ACTIVITIES_WITH_TRANSFERS = [...ACTIVITIES, TRANSFER_ACTIVITY] as const;
export const COUNTER_CASH_ACCOUNT_COLUMN = "counter_cash_account_code";
export const EQUITY_MOVEMENT_TYPES = [
  "OPENING_BALANCE",
  "PROFIT_OR_LOSS",
  "OTHER_COMPREHENSIVE_INCOME",
  "ISSUE_OF_SHARES",
  "DIVIDENDS_OR_DISTRIBUTIONS",
  "TRANSFER_BETWEEN_COMPONENTS",
  "PRIOR_PERIOD_ADJUSTMENT",
  "OTHER_MOVEMENT",
  "CLOSING_BALANCE",
] as const;
export const BUDGET_NATURES = ["REVENUE", "EXPENSE", "ASSET", "LIABILITY", "OTHER"] as const;
export const IPSAS_SECTIONS = ["OPENING_CASH", "RECEIPTS", "PAYMENTS", "THIRD_PARTY_PAYMENTS", "CLOSING_CASH"] as const;
export const SCHEDULE_ROLES = ["OPENING", "ADDITION", "DISPOSAL", "OTHER_ADD", "OTHER_SUBTRACT", "CLOSING", "DETAIL", "TOTAL"] as const;
export const NOTE_KINDS = ["NOTE", "POLICY", "DISCLOSURE"] as const;
export const APPLICABILITY = ["APPLICABLE", "NOT_APPLICABLE"] as const;
export const CASH_CATEGORIES = ["BANK_ACCOUNT", "CASH_ON_HAND", "MOBILE_MONEY", "DESIGNATED_PROJECT", "RESTRICTED_CASH", "OVERDRAFT", "CASH_ECL_ALLOWANCE", "EXCLUDED_NON_CASH"] as const;
export const CASH_EFFECTS = ["ADD", "SUBTRACT"] as const;
/** Categories whose balances are part of cash and cash equivalents and therefore of the cash-flow closing figure. */
export const CASH_ASSET_CATEGORIES = ["BANK_ACCOUNT", "CASH_ON_HAND", "MOBILE_MONEY", "DESIGNATED_PROJECT", "RESTRICTED_CASH"] as const;
export const PRIOR_STATEMENT_TYPES = ["FINANCIAL_POSITION", "PROFIT_OR_LOSS", "CHANGES_IN_EQUITY", "CASH_FLOWS", "CASH_RECEIPTS_AND_PAYMENTS"] as const;

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

function uniqueKey(rows: RowAccess, columns: readonly string[], code: string, what: string): EvidenceDiagnostic[] {
  const seen = new Map<string, number>();
  const out: EvidenceDiagnostic[] = [];
  for (let i = 0; i < rows.count; i++) {
    const key = columns.map((c) => rows.cell(i, c)).join("\u0000");
    const first = seen.get(key);
    if (first === undefined) seen.set(key, i + 1);
    else out.push(err(code, `${what} appears on row ${first} and again on row ${i + 1}.`, i + 1, columns[0], rows.cell(i, columns[0])));
  }
  return out;
}

const blank = (v: string) => v.trim() === "";
const isZeroDecimal = (v: string) => /^-?0+(?:\.0+)?$/.test(v.trim());
const isNegative = (v: string) => v.trim().startsWith("-") && !isZeroDecimal(v);

export const FAMILY_SCHEMAS: Readonly<Record<Exclude<EvidenceType, "TRIAL_BALANCE">, FamilySchema>> = {
  TRANSACTION_LEDGER: {
    hasAmounts: true,
    columns: [
      req("transaction_id", "KEY"),
      req("date", "DATE"),
      req("cash_account_code", "CODE"),
      req("description", "TEXT"),
      opt("receipt", "DECIMAL"),
      opt("payment", "DECIMAL"),
      req("activity", { oneOf: ACTIVITIES }),
      req("cash_flow_line", "TEXT"),
    ],
    crossRow(rows, ctx) {
      const out: EvidenceDiagnostic[] = [...uniqueKey(rows, ["transaction_id"], "DUPLICATE_TRANSACTION_ID", "Transaction id")];
      const seenBody = new Map<string, number>();
      for (let i = 0; i < rows.count; i++) {
        const r = rows.cell(i, "receipt");
        const p = rows.cell(i, "payment");
        if (blank(r) === blank(p)) out.push(err("EXACTLY_ONE_OF_RECEIPT_OR_PAYMENT", "Each cash transaction must have exactly one of receipt or payment; a blank is not a zero.", i + 1, "receipt", `${r}|${p}`));
        for (const [col, v] of [["receipt", r], ["payment", p]] as const) {
          if (!blank(v) && isNegative(v)) out.push(err("NEGATIVE_AMOUNT_NOT_ALLOWED", `${col} must not be negative — record a reversal as the opposite cash direction.`, i + 1, col, v));
        }
        const date = rows.cell(i, "date");
        if (ctx.periodStart && ctx.periodEnd && !blank(date) && (date < ctx.periodStart || date > ctx.periodEnd)) {
          out.push(err("DATE_OUTSIDE_PERIOD", `Date ${date} is outside the reporting period ${ctx.periodStart} to ${ctx.periodEnd}.`, i + 1, "date", date));
        }
        const body = [date, rows.cell(i, "cash_account_code"), rows.cell(i, "description"), r, p].join("\u0000");
        const first = seenBody.get(body);
        if (first === undefined) seenBody.set(body, i + 1);
        else out.push(warn("POSSIBLE_DUPLICATE_TRANSACTION", `Row ${i + 1} has the same date, account, description and amount as row ${first} under a different transaction id.`, i + 1, "transaction_id", rows.cell(i, "transaction_id")));
      }
      return out;
    },
  },

  EQUITY_MOVEMENTS: {
    hasAmounts: true,
    columns: [req("component", "TEXT"), req("movement_type", { oneOf: EQUITY_MOVEMENT_TYPES }), req("amount", "DECIMAL"), opt("description", "TEXT")],
    crossRow(rows) {
      const out: EvidenceDiagnostic[] = [];
      for (const type of ["OPENING_BALANCE", "CLOSING_BALANCE"]) {
        const comps: string[] = [];
        for (let i = 0; i < rows.count; i++) if (rows.cell(i, "movement_type") === type) comps.push(rows.cell(i, "component"));
        for (const c of duplicates(comps)) out.push(err("DUPLICATE_BALANCE_ROW", `Component "${c}" has more than one ${type} row.`, undefined, "component", c));
      }
      return out;
    },
  },

  BUDGET: {
    hasAmounts: true,
    columns: [req("line_key", "KEY"), req("line_label", "TEXT"), req("nature", { oneOf: BUDGET_NATURES }), req("original_budget", "DECIMAL"), opt("final_budget", "DECIMAL"), opt("explanation", "LONGTEXT")],
    crossRow: (rows) => uniqueKey(rows, ["line_key"], "DUPLICATE_LINE_KEY", "Budget line key"),
  },

  IPSAS_CASH_RECEIPTS_PAYMENTS: {
    hasAmounts: true,
    columns: [req("section", { oneOf: IPSAS_SECTIONS }), req("line_key", "KEY"), req("line_label", "TEXT"), req("amount", "DECIMAL"), opt("category", "TEXT")],
    crossRow(rows) {
      const out: EvidenceDiagnostic[] = [...uniqueKey(rows, ["section", "line_key"], "DUPLICATE_LINE_KEY", "Line key")];
      for (const section of ["OPENING_CASH", "CLOSING_CASH"]) {
        const n = Array.from({ length: rows.count }, (_, i) => i).filter((i) => rows.cell(i, "section") === section).length;
        if (n > 1) out.push(err("DUPLICATE_BALANCE_ROW", `${section} must appear at most once; found ${n} rows.`, undefined, "section", section));
      }
      for (let i = 0; i < rows.count; i++) {
        if (isNegative(rows.cell(i, "amount"))) out.push(err("NEGATIVE_AMOUNT_NOT_ALLOWED", "Cash receipts and payments are stated as positive amounts; the section carries the direction.", i + 1, "amount", rows.cell(i, "amount")));
      }
      return out;
    },
  },

  SUPPORTING_SCHEDULE: {
    hasAmounts: true,
    columns: [req("schedule_key", "KEY"), req("schedule_title", "TEXT"), req("role", { oneOf: SCHEDULE_ROLES }), req("row_label", "TEXT"), req("amount", "DECIMAL"), opt("ties_to_line_key", "KEY")],
    crossRow(rows) {
      const out: EvidenceDiagnostic[] = [];
      const titles = new Map<string, string>();
      for (let i = 0; i < rows.count; i++) {
        const k = rows.cell(i, "schedule_key");
        const t = rows.cell(i, "schedule_title");
        if (titles.has(k) && titles.get(k) !== t) out.push(err("SCHEDULE_TITLE_CONFLICT", `Schedule "${k}" has two different titles.`, i + 1, "schedule_title", t));
        titles.set(k, t);
      }
      for (const role of ["OPENING", "CLOSING", "TOTAL"]) {
        const per = new Map<string, number>();
        for (let i = 0; i < rows.count; i++) if (rows.cell(i, "role") === role) per.set(rows.cell(i, "schedule_key"), (per.get(rows.cell(i, "schedule_key")) ?? 0) + 1);
        for (const [k, n] of per) if (n > 1) out.push(err("DUPLICATE_BALANCE_ROW", `Schedule "${k}" has ${n} ${role} rows; at most one is allowed.`, undefined, "role", role));
      }
      return out;
    },
  },

  NOTES_AND_POLICIES: {
    hasAmounts: false,
    columns: [req("kind", { oneOf: NOTE_KINDS }), req("key", "KEY"), req("title", "TEXT"), req("body", "LONGTEXT"), opt("applies_to_line_keys", "TEXT"), opt("checklist_ref", "KEY"), opt("applicability", { oneOf: APPLICABILITY })],
    crossRow: (rows) => uniqueKey(rows, ["kind", "key"], "DUPLICATE_NOTE_KEY", "Note/policy key"),
  },

  PRIOR_PERIOD_STATEMENTS: {
    hasAmounts: true,
    columns: [req("statement_type", { oneOf: PRIOR_STATEMENT_TYPES }), req("line_key", "KEY"), req("line_label", "TEXT"), req("amount", "DECIMAL"), opt("restated", "YESNO")],
    crossRow: (rows) => uniqueKey(rows, ["statement_type", "line_key"], "DUPLICATE_LINE_KEY", "Prior-period line"),
  },

  CASH_ACCOUNT_MAP: {
    hasAmounts: false,
    columns: [req("account_key", "KEY"), req("category", { oneOf: CASH_CATEGORIES }), req("effect", { oneOf: CASH_EFFECTS }), req("include_in_cash_flow", "YESNO"), opt("note", "TEXT")],
    crossRow(rows) {
      const out: EvidenceDiagnostic[] = [...uniqueKey(rows, ["account_key"], "ACCOUNT_MAPPED_TWICE", "Account key")];
      for (let i = 0; i < rows.count; i++) {
        const cat = rows.cell(i, "category");
        const inc = rows.cell(i, "include_in_cash_flow").toUpperCase().startsWith("Y");
        const asset = (CASH_ASSET_CATEGORIES as readonly string[]).includes(cat);
        if (asset && !inc) out.push(err("CASH_MAP_INCONSISTENT", `${cat} balances are part of cash and cash equivalents; include_in_cash_flow must be Y.`, i + 1, "include_in_cash_flow", rows.cell(i, "include_in_cash_flow")));
        if ((cat === "EXCLUDED_NON_CASH" || cat === "CASH_ECL_ALLOWANCE") && inc) out.push(err("CASH_MAP_INCONSISTENT", `${cat} is not part of the cash-flow closing figure; include_in_cash_flow must be N.`, i + 1, "include_in_cash_flow", rows.cell(i, "include_in_cash_flow")));
      }
      return out;
    },
  },

  EXTRACTED_CANDIDATES: {
    hasAmounts: false,
    columns: [req("candidate_id", "KEY"), req("source_ref", "TEXT"), req("field", "TEXT"), req("value", "TEXT"), opt("confidence", "TEXT")],
    crossRow: (rows) => uniqueKey(rows, ["candidate_id"], "DUPLICATE_CANDIDATE_ID", "Candidate id"),
  },
};

/** An exact decimal string (already validated as a plain, non-negative decimal of at most six places) as an integer of 10^-12 units. */
const exact = (v: string): bigint => {
  const [i, f = ""] = v.trim().split(".");
  return BigInt(i + f.padEnd(12, "0"));
};
const showExact = (n: bigint): string => {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(13, "0");
  const frac = s.slice(-12).replace(/0+$/, "");
  return `${neg ? "-" : ""}${s.slice(0, -12)}${frac ? `.${frac}` : ""}`;
};
const byCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * TRANSACTION_LEDGER, schema 1.1.0: the 1.0.0 columns and rules unchanged, plus counter_cash_account_code and the transfer
 * activity. Fail-closed rules on the transfer legs (the cash perimeter itself is checked later, by the per-account roll-forward,
 * which refuses any ledger row naming an account that is not an established cash account):
 *   - a transfer names its counter account, which is a different account; an ordinary row names none;
 *   - for every pair of accounts, the legs recorded between them net to zero within the period — a transfer whose other leg is
 *     missing, differs, or runs the same way is money entering or leaving the pair, i.e. a cash flow, and is refused.
 */
export const TRANSACTION_LEDGER_WITH_TRANSFERS: FamilySchema = {
  hasAmounts: true,
  columns: [
    ...FAMILY_SCHEMAS.TRANSACTION_LEDGER.columns.map((c) => (c.name === "activity" ? req("activity", { oneOf: LEDGER_ACTIVITIES_WITH_TRANSFERS }) : c)),
    opt(COUNTER_CASH_ACCOUNT_COLUMN, "CODE"),
  ],
  crossRow(rows, ctx) {
    const out: EvidenceDiagnostic[] = [...FAMILY_SCHEMAS.TRANSACTION_LEDGER.crossRow!(rows, ctx)];
    const pairs = new Map<string, { a: string; b: string; net: bigint; rows: number[] }>();
    for (let i = 0; i < rows.count; i++) {
      const own = rows.cell(i, "cash_account_code");
      const counter = rows.cell(i, COUNTER_CASH_ACCOUNT_COLUMN);
      const isTransfer = rows.cell(i, "activity") === TRANSFER_ACTIVITY;
      if (!isTransfer) {
        if (!blank(counter)) out.push(err("COUNTER_ACCOUNT_ONLY_ON_TRANSFERS", `Row ${i + 1} is not a transfer between cash accounts, so it must not name a counter cash account.`, i + 1, COUNTER_CASH_ACCOUNT_COLUMN, counter));
        continue;
      }
      if (blank(counter)) {
        out.push(err("TRANSFER_COUNTER_ACCOUNT_REQUIRED", `Row ${i + 1} is a transfer between cash accounts and must name the other cash account in ${COUNTER_CASH_ACCOUNT_COLUMN}.`, i + 1, COUNTER_CASH_ACCOUNT_COLUMN, counter));
        continue;
      }
      if (counter === own) {
        out.push(err("TRANSFER_TO_SAME_ACCOUNT", `Row ${i + 1} records a transfer from account ${own} to itself.`, i + 1, COUNTER_CASH_ACCOUNT_COLUMN, counter));
        continue;
      }
      const r = rows.cell(i, "receipt");
      const amount = blank(r) ? -exact(rows.cell(i, "payment")) : exact(r);
      const [a, b] = [own, counter].sort(byCodepoint);
      const key = `${a}\u0000${b}`;
      const cur = pairs.get(key) ?? { a, b, net: 0n, rows: [] };
      pairs.set(key, { a, b, net: cur.net + amount, rows: [...cur.rows, i + 1] });
    }
    for (const key of [...pairs.keys()].sort(byCodepoint)) {
      const p = pairs.get(key)!;
      if (p.net !== 0n) {
        out.push(err("TRANSFER_LEGS_DO_NOT_MATCH",
          `The transfers recorded between cash accounts ${p.a} and ${p.b} (rows ${p.rows.join(", ")}) do not net to zero (net ${showExact(p.net)}). Each transfer needs both legs in this ledger: a payment on one account and a receipt of the same amount on the other, each naming the other account. Money leaving the two accounts is a cash flow, not a transfer; a transfer still in transit at the period end belongs to a cash-in-transit account in the cash account map.`,
          p.rows[0], COUNTER_CASH_ACCOUNT_COLUMN, `${p.a}|${p.b}`));
      }
    }
    return out;
  },
};

/** The schema (and its version) a file of this family is read under. Only a ledger whose header names the counter column is 1.1.0. */
export function familySchemaFor(type: Exclude<EvidenceType, "TRIAL_BALANCE">, header: readonly string[]): { readonly schema: FamilySchema; readonly schemaVersion: string } {
  if (type === "TRANSACTION_LEDGER" && header.includes(COUNTER_CASH_ACCOUNT_COLUMN)) return { schema: TRANSACTION_LEDGER_WITH_TRANSFERS, schemaVersion: LEDGER_TRANSFER_SCHEMA_VERSION };
  return { schema: FAMILY_SCHEMAS[type], schemaVersion: EVIDENCE_SCHEMA_VERSION };
}
