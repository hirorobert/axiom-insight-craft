/**
 * Imbalance investigation (20261118100000): leads in an out-of-balance trial-balance FILE, computed once per evaluation
 * under a durable reservation (tb_investigation_reserve / tb_investigation_complete) and bounded in work and size.
 *
 * What it is: a list of rows whose figures would explain the difference if they were wrong, missing or misplaced — an
 * amount equal to the difference, one equal to half of it (on the wrong side), a pair of transposed digits, rows read as
 * totals, rows with amounts that were not read as accounts. Each lead names its rows and says what to check.
 *
 * What it is NOT: a correction, an adjustment, a suspense entry or a plug — nothing here proposes a figure to add. And it
 * never claims the originating ledger is unbalanced: a file can be out of balance because of the export (a filter, a
 * hidden row, a subtotal, a column read differently), so every lead is about this file, to be checked against the
 * accounting system. Pure; deterministic for the same file.
 */
import { formatMinor, type IngestResult } from "./tbIngestion.ts";

export const INVESTIGATION_FORMAT = "tb-investigation/1";
/** Hard bounds: leads returned, rows named per lead, accounts examined for digit transpositions. */
export const MAX_LEADS = 20;
export const MAX_ROWS_PER_LEAD = 10;
export const MAX_TRANSPOSITION_ACCOUNTS = 20000;

export type LeadKind =
  | "amount_equals_difference" | "amount_equals_half_difference" | "digit_transposition" | "rows_read_as_totals"
  | "rows_with_amounts_not_read" | "both_sides_on_one_row";

export interface Lead { kind: LeadKind; rows: number[]; check: string }
export interface InvestigationResult {
  format: typeof INVESTIGATION_FORMAT;
  difference: string;
  /** Which side is larger in this file. */
  larger: "debits" | "credits";
  leads: Lead[];
  /** Leads found beyond MAX_LEADS (never silently dropped: their number is stated). */
  more: number;
  statement: string;
}

const STATEMENT = "These are leads in this file to check against your accounting system, not conclusions. The figures in a file "
  + "alone do not show whether the ledger itself balances: an export can be out of balance because of a filter, a hidden or "
  + "subtotal row, or a column read differently. Correct the source and upload it again; nothing here adds, removes or "
  + "adjusts an amount.";

const abs = (x: bigint) => (x < 0n ? -x : x);

/** Every value obtained by swapping two adjacent digits of n (n > 0), with the change it makes. */
function adjacentSwaps(n: bigint): bigint[] {
  const s = n.toString();
  const out: bigint[] = [];
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i] === s[i + 1]) continue;
    const t = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
    if (t[0] === "0" && t.length > 1) continue;
    out.push(BigInt(t));
  }
  return out;
}

export function investigateImbalance(r: IngestResult): InvestigationResult | null {
  if (!r.totals || r.totals.differenceMinor === 0n || r.exponent === null || r.exponent === undefined) return null;
  const exp = r.exponent;
  const diff = abs(r.totals.differenceMinor);
  const fmt = (m: bigint) => formatMinor(m, exp);
  const leads: Lead[] = [];
  const cap = (rows: number[]) => [...new Set(rows)].sort((a, b) => a - b).slice(0, MAX_ROWS_PER_LEAD);
  const amounts = r.accounts.flatMap((a) => [
    ...(a.debitMinor !== 0n ? [{ row: a.sourceRowNumber, side: "debit" as const, v: a.debitMinor }] : []),
    ...(a.creditMinor !== 0n ? [{ row: a.sourceRowNumber, side: "credit" as const, v: a.creditMinor }] : []),
  ]);

  const equal = amounts.filter((x) => x.v === diff);
  if (equal.length) leads.push({ kind: "amount_equals_difference", rows: cap(equal.map((x) => x.row)),
    check: `An amount of ${fmt(diff)} — the whole difference — is on ${equal.length === 1 ? "this row" : "these rows"}. Check whether its counterpart is missing from the file, or whether the row belongs in this trial balance.` });

  if (diff % 2n === 0n) {
    const half = amounts.filter((x) => x.v === diff / 2n);
    if (half.length) leads.push({ kind: "amount_equals_half_difference", rows: cap(half.map((x) => x.row)),
      check: `An amount of ${fmt(diff / 2n)} — half the difference — is on ${half.length === 1 ? "this row" : "these rows"}. An amount entered on the wrong side would produce exactly this difference; check the side in your accounting system.` });
  }

  if (diff % 9n === 0n) {
    const swapped = amounts.slice(0, MAX_TRANSPOSITION_ACCOUNTS).filter((x) => adjacentSwaps(x.v).some((t) => abs(t - x.v) === diff));
    if (swapped.length) leads.push({ kind: "digit_transposition", rows: cap(swapped.map((x) => x.row)),
      check: `Swapping two neighbouring digits of an amount on ${swapped.length === 1 ? "this row" : "these rows"} changes it by exactly ${fmt(diff)}. Compare the figure with your accounting system.` });
  }

  const totalRows = r.issues.filter((i) => i.code === "TRIAL_BALANCE_IMBALANCE").flatMap((i) => i.rows ?? []);
  if (totalRows.length) leads.push({ kind: "rows_read_as_totals", rows: cap(totalRows),
    check: "These rows have account codes but read like totals or subtotals. If they are subtotals, they are counted twice; remove them in the export." });

  const unread = r.lineage.filter((l) => l.disposition === "rejected").map((l) => l.rowNumber);
  if (unread.length) leads.push({ kind: "rows_with_amounts_not_read", rows: cap(unread),
    check: "These rows have amounts that were not read as accounts (no account code or name, or an unreadable amount). If they belong in the trial balance, give them a code and name in the export." });

  const both = r.accounts.filter((a) => a.debitMinor !== 0n && a.creditMinor !== 0n).map((a) => a.sourceRowNumber);
  if (both.length) leads.push({ kind: "both_sides_on_one_row", rows: cap(both),
    check: "These rows carry both a debit and a credit. Check that each is the account's real balance and not a movement column." });

  return {
    format: INVESTIGATION_FORMAT,
    difference: fmt(diff),
    larger: r.totals.differenceMinor > 0n ? "debits" : "credits",
    leads: leads.slice(0, MAX_LEADS),
    more: Math.max(0, leads.length - MAX_LEADS),
    statement: STATEMENT,
  };
}
