// financialGeneration/cashPerimeter.ts — deterministic multi-account cash authority.
//
// An entity's cash is many accounts: several banks, cash on hand, mobile money,
// project/designated accounts, restricted cash, overdrafts, an ECL allowance on cash
// balances, and balances that look like cash but are not. Which account is which is an
// EXPLICIT professional decision recorded in a CASH_ACCOUNT_MAP evidence batch; nothing
// here picks a "first" account, guesses from a name, or fills a gap.
//
// For each period, from the trial-balance statement of financial position:
//
//   A  gross cash            = Σ contributions of BANK, CASH_ON_HAND, MOBILE_MONEY,
//                              DESIGNATED_PROJECT, RESTRICTED_CASH accounts   (before ECL)
//   R  of which restricted   = RESTRICTED_CASH + DESIGNATED_PROJECT
//   E  ECL allowance         = Σ contributions of CASH_ECL_ALLOWANCE accounts (signed)
//   O  overdrafts in cash    = Σ contributions of OVERDRAFT accounts flagged include_in_cash_flow = Y
//   X  excluded non-cash     = Σ contributions of EXCLUDED_NON_CASH accounts (disclosed, not in cash)
//   cash-flow closing cash   = A + O
//   net SFP cash             = A + E
//
// where a contribution is the account's SFP balance, added or subtracted as the map says.
// The canonical rule then tests the ledger-derived cash-flow closing figure against A + O
// and shows the reconciliation  closing cash − ECL allowance + overdraft in cash = net SFP cash.
// If the perimeter cannot be established (a mapped account missing from the trial balance,
// a reviewed cash account with no category, a missing figure) NO figure is produced and the
// rule reports insufficient evidence. There is no plug.

import { addMoney, subtractMoney, money, type Money } from "@/lib/canonicalStatement/money";
import type { CanonicalFinancialStatementReport, MonetaryFact, Note } from "@/lib/canonicalStatement/types";
import { CASH_ASSET_CATEGORIES } from "@/lib/financialEvidence/schemas";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { columnReader, evidenceFact, periodRef, type GenerationDiagnostic } from "./common";

export const CASH_PERIMETER_NOTE_ID = "note:cash-perimeter";
export const cashPerimeterFactId = (role: CashPerimeterRole, periodId: string) => `fact:cashperim:${role}:${periodId}`;

export type CashPerimeterRole = "gross" | "restricted" | "ecl" | "overdraft" | "net" | "cfexpected" | "excluded";

export interface CashPerimeterAccount {
  readonly accountKey: string;
  readonly category: string;
  readonly effect: "ADD" | "SUBTRACT";
  readonly includeInCashFlow: boolean;
  readonly mapRow: number;
}

export interface CashPerimeterResult {
  readonly status: "ESTABLISHED" | "UNRESOLVED";
  readonly facts: readonly MonetaryFact[];
  readonly note: Note | null;
  /** Per period, the composition by category — for the disclosure table. */
  readonly composition: readonly { readonly periodId: string; readonly byCategory: Readonly<Record<string, Money>>; readonly accounts: readonly { accountKey: string; category: string; contribution: Money }[] }[];
  readonly diagnostics: readonly GenerationDiagnostic[];
  readonly reasons: readonly string[];
}

function latestValue(report: CanonicalFinancialStatementReport, factId: string): Money | null {
  let best: MonetaryFact | null = null;
  for (const f of report.facts) if (f.factId === factId && (!best || f.version > best.version)) best = f;
  return best?.value ?? null;
}

export function readCashAccountMap(batch: EvidenceBatch): CashPerimeterAccount[] {
  const read = columnReader(batch);
  return Array.from({ length: batch.document.rows.length }, (_, i) => i + 1).map((row) => ({
    accountKey: read(row, "account_key"),
    category: read(row, "category"),
    effect: read(row, "effect") as "ADD" | "SUBTRACT",
    includeInCashFlow: read(row, "include_in_cash_flow").toUpperCase().startsWith("Y"),
    mapRow: row,
  }));
}

export function establishCashPerimeter(input: {
  readonly report: CanonicalFinancialStatementReport;
  readonly map: EvidenceBatch;
  /** Account keys the trial-balance review flagged as cash accounts. Each one MUST appear in the map. */
  readonly reviewedCashAccountKeys: readonly string[];
}): CashPerimeterResult {
  const { report, map } = input;
  const diagnostics: GenerationDiagnostic[] = [];
  const reasons: string[] = [];
  const accounts = readCashAccountMap(map);
  const periods = [report.period.periodId, ...report.comparativePeriods.map((p) => p.periodId)];
  const zero = money(report.presentationCurrency.currency, report.presentationCurrency.scale, 0n);
  const isComparative = (id: string) => id !== report.period.periodId;

  const mappedKeys = new Set(accounts.map((a) => a.accountKey));
  for (const key of input.reviewedCashAccountKeys) {
    if (!mappedKeys.has(key)) {
      reasons.push(`Account ${key} is reviewed as a cash account but has no category in the cash account map.`);
      diagnostics.push({ code: "CASH_ACCOUNT_UNMAPPED", severity: "ERROR", message: `Account ${key} is reviewed as a cash account but has no category in the cash account map, so the cash perimeter is ambiguous. Add it to the map.` });
    }
  }
  const sfp = report.statements.find((s) => s.type === "STATEMENT_OF_FINANCIAL_POSITION");
  const lineFor = (key: string) => sfp?.sections.flatMap((s) => s.lines).find((l) => l.lineId === `line:detail:sfp:${key}`);
  for (const a of accounts) {
    if (!lineFor(a.accountKey)) {
      reasons.push(`Mapped account ${a.accountKey} (map row ${a.mapRow}) is not a line of the statement of financial position.`);
      diagnostics.push({ code: "CASH_ACCOUNT_NOT_IN_TRIAL_BALANCE", severity: "ERROR", message: `Mapped account ${a.accountKey} (map row ${a.mapRow}) is not on the statement of financial position; it is not silently ignored.` });
    }
  }

  const facts: MonetaryFact[] = [];
  const composition: { periodId: string; byCategory: Record<string, Money>; accounts: { accountKey: string; category: string; contribution: Money }[] }[] = [];
  const established: string[] = [];

  if (reasons.length === 0) {
    for (const periodId of periods) {
      const missing: string[] = [];
      const contributions: { a: CashPerimeterAccount; v: Money }[] = [];
      for (const a of accounts) {
        const line = lineFor(a.accountKey)!;
        const factId = line.factBindings.find((b) => b.periodId === periodId)?.factId;
        const value = factId ? latestValue(report, factId) : null;
        if (value === null) missing.push(a.accountKey);
        else contributions.push({ a, v: a.effect === "ADD" ? value : subtractMoney(zero, value) });
      }
      if (missing.length > 0) {
        const msg = `No balance for account(s) ${missing.join(", ")} in period ${periodId}; the cash perimeter is not established for that period.`;
        if (isComparative(periodId)) diagnostics.push({ code: "CASH_PERIMETER_COMPARATIVE_INCOMPLETE", severity: "WARNING", message: msg });
        else {
          reasons.push(msg);
          diagnostics.push({ code: "CASH_PERIMETER_BALANCE_MISSING", severity: "ERROR", message: msg });
        }
        continue;
      }
      const sum = (pred: (a: CashPerimeterAccount) => boolean) => contributions.filter((c) => pred(c.a)).reduce((acc, c) => addMoney(acc, c.v), zero);
      const isAsset = (a: CashPerimeterAccount) => (CASH_ASSET_CATEGORIES as readonly string[]).includes(a.category);
      const A = sum(isAsset);
      const R = sum((a) => a.category === "RESTRICTED_CASH" || a.category === "DESIGNATED_PROJECT");
      const E = sum((a) => a.category === "CASH_ECL_ALLOWANCE");
      const O = sum((a) => a.category === "OVERDRAFT" && a.includeInCashFlow);
      const X = sum((a) => a.category === "EXCLUDED_NON_CASH");
      const keysOf = (pred: (a: CashPerimeterAccount) => boolean) => accounts.filter(pred).map((a) => a.accountKey).join(", ") || "none";
      const pr = periodRef(periodId, isComparative(periodId));
      const put = (role: CashPerimeterRole, v: Money, text: string) => facts.push(evidenceFact(map, cashPerimeterFactId(role, periodId), v, pr, 0, text));
      put("gross", A, `gross cash before ECL: accounts ${keysOf(isAsset)}`);
      put("restricted", R, `restricted and designated cash: accounts ${keysOf((a) => a.category === "RESTRICTED_CASH" || a.category === "DESIGNATED_PROJECT")}`);
      put("ecl", E, `ECL allowance on cash (signed): accounts ${keysOf((a) => a.category === "CASH_ECL_ALLOWANCE")}`);
      put("overdraft", O, `overdrafts included in cash and cash equivalents (signed): accounts ${keysOf((a) => a.category === "OVERDRAFT" && a.includeInCashFlow)}`);
      put("excluded", X, `balances mapped as not cash: accounts ${keysOf((a) => a.category === "EXCLUDED_NON_CASH")}`);
      put("cfexpected", addMoney(A, O), "cash-flow closing cash expected from the perimeter: gross cash plus overdrafts included");
      put("net", addMoney(A, E), "net cash on the statement of financial position: gross cash plus the (negative) ECL allowance");
      const byCategory: Record<string, Money> = {};
      for (const c of contributions) byCategory[c.a.category] = addMoney(byCategory[c.a.category] ?? zero, c.v);
      composition.push({ periodId, byCategory, accounts: contributions.map((c) => ({ accountKey: c.a.accountKey, category: c.a.category, contribution: c.v })) });
      established.push(periodId);
    }
    if (!established.includes(report.period.periodId) && reasons.length === 0) reasons.push("The current-period cash perimeter could not be established.");
  }

  const ok = reasons.length === 0;
  const note: Note = {
    noteId: CASH_PERIMETER_NOTE_ID,
    noteNumber: "0",
    title: ok ? "Cash and cash equivalents" : "Cash and cash equivalents — perimeter not established",
    monetaryFactIds: ok ? [cashPerimeterFactId("gross", report.period.periodId), cashPerimeterFactId("overdraft", report.period.periodId), cashPerimeterFactId("cfexpected", report.period.periodId)] : [],
    ...(ok ? { totalFactId: cashPerimeterFactId("cfexpected", report.period.periodId) } : {}),
  };
  if (ok) diagnostics.push({ code: "CASH_PERIMETER_ESTABLISHED", severity: "INFO", message: `Cash perimeter established from ${accounts.length} mapped account(s) for ${established.length} period(s).` });
  return { status: ok ? "ESTABLISHED" : "UNRESOLVED", facts: ok ? facts : [], note, composition: ok ? composition : [], diagnostics, reasons };
}
