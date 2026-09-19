// financialGeneration/cashLedgerAuthority.ts — is the cash ledger COMPLETE, account by account?
//
// DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001 said the product had no period-complete,
// classified cash-movement ledger, so a cash-flow statement could not be independently
// checked. The workspace now accepts exactly such a ledger as controlled evidence
// (TRANSACTION_LEDGER: every row carries a cash account, a date inside the period, an amount
// and an explicit activity / presentation line). What was still missing was PROOF OF
// COMPLETENESS. This module supplies it, deterministically and without any balancing figure:
//
//   for every cash account the professional review has established (an explicit cash account map,
//   or exactly one account reviewed as cash), the movement RECORDED IN THE LEDGER for that account
//   must equal the movement in that account's balance between the two reviewed trial balances.
//
//   ledger movement(account) = Σ receipts − Σ payments of the rows naming the account
//   trial-balance movement   = contribution(current) − contribution(comparative)
//                              (contribution = the account's balance, added or subtracted per the map)
//
// A ledger that omits a transaction, mis-states one, names an account the review did not establish
// as cash, or is silent about an account whose balance moved, cannot reconcile — and the canonical
// rule `cashflow-account-rollforward` reports it. Nothing here estimates, defaults or plugs:
// when an input is missing the authority is UNRESOLVED and the rule reports INSUFFICIENT_EVIDENCE.
//
// Everything is order-independent: accounts are processed in code-point order and amounts are
// exact integers, so any permutation of the map rows or the ledger rows yields identical figures.

import { addMoney, negateMoney, subtractMoney, money, type Money } from "@/lib/canonicalStatement/money";
import type { CanonicalFinancialStatementReport, MonetaryFact, Note } from "@/lib/canonicalStatement/types";
import { CASH_ASSET_CATEGORIES } from "@/lib/financialEvidence/schemas";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { amountOf, byCodepoint, columnReader, describeRows, evidenceFact, periodRef, slug, type GenerationDiagnostic } from "./common";
import type { CashPerimeterAccount } from "./cashPerimeter";

export const CASH_LEDGER_AUTHORITY_NOTE_ID = "note:cash-ledger-authority";
export type CashRollRole = "ledger" | "tb" | "orphan";
export const cashRollFactId = (role: CashRollRole, key: string) => `fact:cashroll:${role}:${slug(key)}`;

export interface CashLedgerAuthorityAccount {
  readonly accountKey: string;
  readonly category: string;
  readonly effect: "ADD" | "SUBTRACT";
  readonly includeInCashFlow: boolean;
}

export interface CashRollRow {
  readonly accountKey: string;
  readonly ledgerMovement: Money;
  /** null = the trial-balance movement could not be established (an input balance is missing). */
  readonly tbMovement: Money | null;
  readonly difference: Money | null;
}

export interface CashLedgerAuthorityResult {
  readonly status: "NOT_APPLICABLE" | "ESTABLISHED" | "UNRESOLVED";
  readonly facts: readonly MonetaryFact[];
  readonly note: Note | null;
  readonly rows: readonly CashRollRow[];
  /** Ledger movement recorded against accounts that are not cash-flow cash accounts in the review. */
  readonly orphans: readonly { readonly code: string; readonly movement: Money }[];
  readonly reasons: readonly string[];
  readonly diagnostics: readonly GenerationDiagnostic[];
}

const isCashFlowAccount = (a: CashLedgerAuthorityAccount) => (CASH_ASSET_CATEGORIES as readonly string[]).includes(a.category) || (a.category === "OVERDRAFT" && a.includeInCashFlow);

/** The explicit accounts of a perimeter map, in the shape this module needs. */
export function accountsFromPerimeterMap(accounts: readonly CashPerimeterAccount[]): CashLedgerAuthorityAccount[] {
  return accounts.map((a) => ({ accountKey: a.accountKey, category: a.category, effect: a.effect, includeInCashFlow: a.includeInCashFlow }));
}

/** Exactly one account reviewed as cash and no map: that reviewed account is the whole perimeter. */
export function accountsFromSingleReviewedCash(key: string): CashLedgerAuthorityAccount[] {
  return [{ accountKey: key, category: "BANK_ACCOUNT", effect: "ADD", includeInCashFlow: true }];
}

function latestValue(report: CanonicalFinancialStatementReport, factId: string | undefined): Money | null {
  if (!factId) return null;
  let best: MonetaryFact | null = null;
  for (const f of report.facts) if (f.factId === factId && (!best || f.version > best.version)) best = f;
  return best?.value ?? null;
}

export function establishCashLedgerAuthority(input: {
  readonly report: CanonicalFinancialStatementReport;
  /** null = no perimeter could be derived at all (no map and not exactly one reviewed cash account). */
  readonly accounts: readonly CashLedgerAuthorityAccount[] | null;
  /** The CURRENT-period cash transaction ledger; null when there is none (then there is no ledger-derived statement to check). */
  readonly ledger: EvidenceBatch | null;
}): CashLedgerAuthorityResult {
  const { report, ledger } = input;
  const diagnostics: GenerationDiagnostic[] = [];
  const reasons: string[] = [];
  const empty = (status: CashLedgerAuthorityResult["status"], note: Note | null): CashLedgerAuthorityResult => ({ status, facts: [], note, rows: [], orphans: [], reasons, diagnostics });
  if (!ledger) return empty("NOT_APPLICABLE", null);

  const unresolvedNote: Note = { noteId: CASH_LEDGER_AUTHORITY_NOTE_ID, noteNumber: "0", title: "Cash ledger completeness by account — not established", monetaryFactIds: [] };
  const cashAccounts = (input.accounts ?? []).filter(isCashFlowAccount);
  if (input.accounts === null || cashAccounts.length === 0) {
    reasons.push("No cash account map was supplied and exactly one account is not reviewed as cash, so the ledger cannot be checked account by account.");
    diagnostics.push({ code: "CASH_LEDGER_AUTHORITY_NO_ACCOUNTS", severity: "ERROR", message: reasons[0] });
    return empty("UNRESOLVED", unresolvedNote);
  }

  // Aggregates (sums of one or more ledger rows) are COMPUTED facts: they carry an explicit derivation instead of borrowing the locator of a row,
  // so a single-row account can never collide with the cash-flow line fact built from that same row (duplicate-detection).
  const zero = money(report.presentationCurrency.currency, report.presentationCurrency.scale, 0n);
  const read = columnReader(ledger);
  const byCode = new Map<string, { sum: Money; rows: number[] }>();
  for (let row = 1; row <= ledger.document.rows.length; row++) {
    const code = read(row, "cash_account_code");
    const receipt = read(row, "receipt");
    const amount = receipt !== "" ? amountOf(ledger, receipt) : negateMoney(amountOf(ledger, read(row, "payment")));
    const cur = byCode.get(code);
    byCode.set(code, { sum: cur ? addMoney(cur.sum, amount) : amount, rows: [...(cur?.rows ?? []), row] });
  }

  const current = report.period.periodId;
  const comparative = report.comparativePeriods[0]?.periodId;
  const sfp = report.statements.find((s) => s.type === "STATEMENT_OF_FINANCIAL_POSITION");
  const lineFor = (key: string) => sfp?.sections.flatMap((s) => s.lines).find((l) => l.lineId === `line:detail:sfp:${key}`);
  const contribution = (a: CashLedgerAuthorityAccount, periodId: string | undefined): Money | null => {
    const line = lineFor(a.accountKey);
    const value = latestValue(report, line?.factBindings.find((b) => b.periodId === periodId)?.factId);
    return value === null ? null : a.effect === "ADD" ? value : negateMoney(value);
  };

  const facts: MonetaryFact[] = [];
  const rows: CashRollRow[] = [];
  const period = periodRef(current, false);
  const knownCodes = new Set(cashAccounts.map((a) => a.accountKey));

  const orphans: { code: string; movement: Money }[] = [];
  for (const code of [...byCode.keys()].sort(byCodepoint)) {
    if (knownCodes.has(code)) continue;
    const v = byCode.get(code)!;
    orphans.push({ code, movement: v.sum });
    facts.push(evidenceFact(ledger, cashRollFactId("orphan", code), v.sum, period, 0, `ledger rows ${describeRows(v.rows)} name account ${code}, which is not an established cash-flow cash account`));
    reasons.push(`Ledger rows ${describeRows(v.rows)} name account ${code}, which the cash review did not establish as a cash account included in cash flows.`);
    diagnostics.push({ code: "LEDGER_ROW_ACCOUNT_NOT_A_CASH_ACCOUNT", severity: "ERROR", message: `Ledger rows ${describeRows(v.rows)} name account ${code}, which the cash review did not establish as a cash account included in cash flows.` });
  }

  let unresolved = false;
  for (const a of [...cashAccounts].sort((x, y) => byCodepoint(x.accountKey, y.accountKey))) {
    const led = byCode.get(a.accountKey);
    const ledgerMovement = led?.sum ?? zero;
    facts.push(evidenceFact(ledger, cashRollFactId("ledger", a.accountKey), ledgerMovement, period, 0, led ? `ledger movement of account ${a.accountKey}: rows ${describeRows(led.rows)}` : `computed: the ledger records no row for account ${a.accountKey}`));
    const open = contribution(a, comparative);
    const close = contribution(a, current);
    let tb: Money | null = null;
    if (open === null || close === null) {
      unresolved = true;
      const why = `Account ${a.accountKey} has no balance in ${open === null ? "the comparative" : "the current"} statement of financial position, so its movement cannot be checked against the ledger.`;
      reasons.push(why);
      diagnostics.push({ code: "CASH_ROLLFORWARD_BALANCE_MISSING", severity: "ERROR", message: why });
    } else {
      tb = subtractMoney(close, open);
      facts.push(evidenceFact(ledger, cashRollFactId("tb", a.accountKey), tb, period, 0, `computed: balance movement of account ${a.accountKey} between the reviewed trial balances (${a.effect === "ADD" ? "added" : "subtracted"} per the cash review)`));
    }
    rows.push({ accountKey: a.accountKey, ledgerMovement, tbMovement: tb, difference: tb === null ? null : subtractMoney(ledgerMovement, tb) });
  }

  const differing = rows.filter((r) => r.difference !== null && r.difference.minorUnits !== 0n);
  for (const r of differing) reasons.push(`Account ${r.accountKey}: the ledger records a movement that differs from the trial-balance movement.`);
  const status: CashLedgerAuthorityResult["status"] = unresolved || orphans.length > 0 ? "UNRESOLVED" : "ESTABLISHED";
  const note: Note = { noteId: CASH_LEDGER_AUTHORITY_NOTE_ID, noteNumber: "0", title: "Cash ledger completeness by account", monetaryFactIds: facts.map((f) => f.factId) };
  if (status === "ESTABLISHED" && differing.length === 0) diagnostics.push({ code: "CASH_LEDGER_COMPLETE", severity: "INFO", message: `The ledger reconciles, account by account, to the movement of ${rows.length} cash account(s).` });
  return { status, facts, note, rows, orphans, reasons, diagnostics };
}
