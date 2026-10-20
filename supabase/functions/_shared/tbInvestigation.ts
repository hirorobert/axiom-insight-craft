/**
 * Imbalance investigation (20261118100000): what the processing reader saw in an out-of-balance trial-balance FILE,
 * computed once per evaluation under a durable reservation (tb_investigation_reserve / add_rows / complete) and read back
 * page by page from storage — the file is never parsed again for a page.
 *
 * It uses the SAME reader and exact minor-unit amounts as processing (tbSource → tbIngestion). It returns:
 *   · every non-blank row with its source row number, whether it was INCLUDED as an account or EXCLUDED (and why), and
 *     its parsed amounts;
 *   · the totals of the rows read, compared with the file's own PRINTED totals when it has them, and a labelled possible
 *     cause: the export's own totals do not balance either (an export issue) / the reading differs from the printed
 *     totals (a layout or excluded-row issue) / no printed totals to compare;
 *   · bounded leads by row: an amount equal to the difference, half of it (wrong side), a digit transposition, rows read
 *     as totals, rows with amounts not read, both sides on one row.
 *
 * What it is NOT: a correction, an adjustment, a suspense entry or a plug — nothing here proposes a figure to add. And it
 * never claims the originating ledger is unbalanced: every statement is about this file, to be checked against the
 * accounting system. Pure; deterministic for the same file.
 */
import { formatMinor, type IngestResult } from "./tbIngestion.ts";

export const INVESTIGATION_FORMAT = "tb-investigation/2";
/** Hard bounds: leads returned, rows named per lead, amounts examined for digit transpositions, rows stored. */
export const MAX_LEADS = 20;
export const MAX_ROWS_PER_LEAD = 10;
export const MAX_TRANSPOSITION_ACCOUNTS = 20000;
export const MAX_STORED_ROWS = 20000;

export type LeadKind =
  | "amount_equals_difference" | "amount_equals_half_difference" | "digit_transposition" | "rows_read_as_totals"
  | "rows_with_amounts_not_read" | "both_sides_on_one_row";
export type PossibleCause = "export_totals_do_not_balance" | "reading_differs_from_printed_totals" | "reading_agrees_with_printed_totals" | "no_printed_totals";

export interface Lead { kind: LeadKind; rows: number[]; check: string }
export interface InvestigationRow {
  ordinal: number; row_number: number; included: boolean; disposition: string;
  account_code: string | null; account_name: string | null; debit_minor: string | null; credit_minor: string | null; reason: string | null;
}
export interface InvestigationResult {
  format: typeof INVESTIGATION_FORMAT;
  currency: string | null;
  exponent: number;
  difference: string;
  /** Which side is larger in the rows read. */
  larger: "debits" | "credits";
  /** The totals of the rows read as accounts (exact, formatted). */
  read: { debit: string; credit: string };
  /** The file's own printed total rows, as read (row number and amounts). */
  printed: { row: number; debit: string; credit: string }[];
  cause: PossibleCause;
  causeText: string;
  leads: Lead[];
  /** Leads found beyond MAX_LEADS (never silently dropped: their number is stated). */
  more: number;
  row_count: number;
  included_count: number;
  excluded_count: number;
  statement: string;
}

const STATEMENT = "These are leads in this file to check against your accounting system, not conclusions. The figures in a file "
  + "alone do not show whether the ledger itself balances: an export can be out of balance because of a filter, a hidden or "
  + "subtotal row, or a column read differently. Correct the source and upload it again; nothing here adds, removes or "
  + "adjusts an amount.";

const abs = (x: bigint) => (x < 0n ? -x : x);

/** Every value obtained by swapping two adjacent digits of n (n > 0). */
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

export function investigateImbalance(r: IngestResult): { result: InvestigationResult; rows: InvestigationRow[] } | null {
  if (!r.totals || r.totals.differenceMinor === 0n || r.exponent === null || r.exponent === undefined) return null;
  const exp = r.exponent;
  const diff = abs(r.totals.differenceMinor);
  const fmt = (m: bigint) => formatMinor(m, exp);
  const leads: Lead[] = [];
  const cap = (rows: number[]) => [...new Set(rows)].sort((a, b) => a - b).slice(0, MAX_ROWS_PER_LEAD);
  const amounts = r.accounts.flatMap((a) => [
    ...(a.debitMinor !== 0n ? [{ row: a.sourceRowNumber, v: a.debitMinor }] : []),
    ...(a.creditMinor !== 0n ? [{ row: a.sourceRowNumber, v: a.creditMinor }] : []),
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

  // The file's own printed totals (rows the reader identified as totals, with both amounts), compared with the reading.
  const printed = r.lineage.filter((l) => l.disposition === "total" && typeof l.debitMinor === "bigint" && typeof l.creditMinor === "bigint")
    .map((l) => ({ row: l.rowNumber, debit: l.debitMinor as bigint, credit: l.creditMinor as bigint }));
  const last = printed.at(-1) ?? null;
  const readD = r.totals.debitMinor, readC = r.totals.creditMinor;
  let cause: PossibleCause;
  let causeText: string;
  if (!last) {
    cause = "no_printed_totals";
    causeText = "The file has no printed totals to compare with, so the leads below are the evidence available. Compare the file with your accounting system's trial balance.";
  } else if (last.debit === readD && last.credit === readC) {
    cause = last.debit === last.credit ? "reading_agrees_with_printed_totals" : "export_totals_do_not_balance";
    causeText = last.debit === last.credit
      ? `The rows read add up to the file's printed totals on row ${last.row}.`
      : `The file's own printed totals on row ${last.row} (debit ${fmt(last.debit)}, credit ${fmt(last.credit)}) differ by the same ${fmt(diff)}, and the rows read add up to them: the export itself does not balance. That alone does not show whether the ledger itself balances — check how the report was run (period, filters, accounts included) and export it again.`;
  } else {
    cause = "reading_differs_from_printed_totals";
    causeText = `The file's printed totals on row ${last.row} (debit ${fmt(last.debit)}, credit ${fmt(last.credit)}) are not what the rows read add up to (debit ${fmt(readD)}, credit ${fmt(readC)}): some rows were read differently from how the report adds them. Check the excluded rows below and the file's column layout.`;
  }

  // Every non-blank row as the reader saw it, in file order (bounded).
  const byRow = new Map(r.accounts.map((a) => [a.sourceRowNumber, a]));
  const rows: InvestigationRow[] = [];
  for (const l of r.lineage) {
    if (l.disposition === "blank") continue;
    if (rows.length >= MAX_STORED_ROWS) break;
    const a = byRow.get(l.rowNumber);
    const d = a ? a.debitMinor : l.debitMinor;
    const c = a ? a.creditMinor : l.creditMinor;
    rows.push({
      ordinal: rows.length + 1, row_number: l.rowNumber, included: l.disposition === "account", disposition: l.disposition,
      account_code: a ? (a.codeProvided ? a.accountCode : null) : null, account_name: a ? a.accountName : null,
      debit_minor: typeof d === "bigint" ? d.toString() : null, credit_minor: typeof c === "bigint" ? c.toString() : null,
      reason: a ? null : (l.reason ?? null)?.slice(0, 500) ?? null,
    });
  }
  const included = rows.filter((x) => x.included).length;
  return {
    rows,
    result: {
      format: INVESTIGATION_FORMAT, currency: r.currency, exponent: exp,
      difference: fmt(diff), larger: r.totals.differenceMinor > 0n ? "debits" : "credits",
      read: { debit: fmt(readD), credit: fmt(readC) },
      printed: printed.map((p) => ({ row: p.row, debit: fmt(p.debit), credit: fmt(p.credit) })),
      cause, causeText,
      leads: leads.slice(0, MAX_LEADS), more: Math.max(0, leads.length - MAX_LEADS),
      row_count: rows.length, included_count: included, excluded_count: rows.length - included,
      statement: STATEMENT,
    },
  };
}
