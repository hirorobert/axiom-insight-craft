import type { Statement, StatementRow } from "../../../../supabase/functions/_shared/readiness/types";
import { isIsoDate, parseMinor } from "./amount";
import { parseCsv, requireColumns } from "./csv";
import { IntakeError } from "./errors";
import { sha256Hex } from "./sha256";

/**
 * Bank statement export: `Date,Description,Reference,Debit,Credit,Balance,Page`.
 *
 * SIGN CONVENTION (the bank side, which is also the ledger's sign for a cash account): money OUT of the account (the bank's
 * Debit column, a payment) is NEGATIVE; money IN (the Credit column, a receipt) is POSITIVE. So `opening + amount = balance`
 * for every row when the printed balances chain, which is exactly what the readiness engine's running-balance check tests.
 *
 *   - `opening` is derived from the FIRST row (printed balance minus its amount): the statement carries no separate opening line.
 *   - `balance` is stored as printed. A balance that does not chain is NOT repaired here; the engine reports the break.
 *   - `pages_missing` is every page in 1..pagesTotal that no row carries. A page with no transactions on it cannot be told
 *     from a missing page, so a statement is only ever complete when every page has at least one row.
 *   - An empty statement (no rows) is refused: a header-only file is not evidence.
 */
export const BANK_COLUMNS = ["Date", "Description", "Reference", "Debit", "Credit", "Balance", "Page"] as const;
export interface BankMeta { file: string; bankId: string; from: string; to: string; pagesTotal: number; exponent: number }
export interface BankResult { statement: Statement; fileSha256: string; stats: { rows: number; pagesPresent: number[] } }

export function parseBankStatementExport(text: string, meta: BankMeta): BankResult {
  const { file, exponent } = meta;
  if (!isIsoDate(meta.from) || !isIsoDate(meta.to) || meta.from > meta.to) throw new IntakeError(`statement period ${meta.from} to ${meta.to} is not valid`, file, 1);
  if (!Number.isInteger(meta.pagesTotal) || meta.pagesTotal < 1) throw new IntakeError(`pages in the statement (${meta.pagesTotal}) must be a whole number of at least 1`, file, 1);
  const t = parseCsv(text, file);
  const ix = requireColumns(t, BANK_COLUMNS);
  if (t.records.length === 0) throw new IntakeError("the statement has no transactions", file, 1);
  const rows: StatementRow[] = [];
  const pages = new Set<number>();
  let prevDate = "";
  for (const r of t.records) {
    const cell = (n: (typeof BANK_COLUMNS)[number]) => r.fields[ix[n]];
    const where = (n: (typeof BANK_COLUMNS)[number]) => ({ file, line: r.line, column: ix[n] + 1 });
    const date = cell("Date").trim();
    if (!isIsoDate(date)) throw new IntakeError(`Date "${date}" is not an ISO date (YYYY-MM-DD)`, file, r.line, ix.Date + 1);
    if (date < meta.from || date > meta.to) throw new IntakeError(`Date ${date} is outside the statement period ${meta.from} to ${meta.to}`, file, r.line, ix.Date + 1);
    if (date < prevDate) throw new IntakeError(`rows are not in date order (${date} after ${prevDate})`, file, r.line, ix.Date + 1);
    prevDate = date;
    const out = parseMinor(cell("Debit"), exponent, where("Debit"), "Debit");
    const inn = parseMinor(cell("Credit"), exponent, where("Credit"), "Credit");
    if (out > 0n && inn > 0n) throw new IntakeError("a row cannot be both a debit and a credit", file, r.line, ix.Debit + 1);
    if (out === 0n && inn === 0n) throw new IntakeError("a row needs a debit or a credit", file, r.line, ix.Debit + 1);
    const balance = parseMinor(cell("Balance"), exponent, where("Balance"), "Balance", { signed: true, blank: "refuse" });
    const pageText = cell("Page").trim();
    if (!/^[1-9]\d*$/.test(pageText)) throw new IntakeError(`Page "${pageText}" is not a positive whole number`, file, r.line, ix.Page + 1);
    const page = Number(pageText);
    if (page > meta.pagesTotal) throw new IntakeError(`Page ${page} is beyond the ${meta.pagesTotal} pages the statement has`, file, r.line, ix.Page + 1);
    pages.add(page);
    const row: StatementRow = { date, amount: (inn - out).toString(), balance: balance.toString() };
    const ref = cell("Reference").trim();
    if (ref) row.ref = ref;
    rows.push(row);
  }
  const first = rows[0];
  const opening = (BigInt(first.balance as string) - BigInt(first.amount)).toString();
  const pages_missing: number[] = [];
  for (let p = 1; p <= meta.pagesTotal; p++) if (!pages.has(p)) pages_missing.push(p);
  const fileSha256 = sha256Hex(text);
  return {
    statement: { file, sha: fileSha256, from: meta.from, to: meta.to, pages_total: meta.pagesTotal, pages_missing, opening, rows },
    fileSha256, stats: { rows: rows.length, pagesPresent: [...pages].sort((a, b) => a - b) },
  };
}
