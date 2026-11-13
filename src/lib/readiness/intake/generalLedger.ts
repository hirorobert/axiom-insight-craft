import type { LedgerEntry, Line } from "../../../../supabase/functions/_shared/readiness/types";
import { isIsoDate, parseMinor } from "./amount";
import { parseCsv, requireColumns } from "./csv";
import { IntakeError } from "./errors";
import { sha256Hex } from "./sha256";

/**
 * Flat frozen General Ledger export: `Account,Date,Transaction Type,Txn Id,Line,Num,Name,Memo,Debit,Credit`.
 *
 *   - "Beginning Balance" rows are the OPENING balance of an account (one per account, dated before the period).
 *     An account with entries but no Beginning Balance row opens at zero; it is listed in `accountsWithoutOpening`.
 *   - Every other row is an entry dated inside the period. Entry id = `${Txn Id}#${Line}`; ref = Num.
 *   - Every transaction must balance, exactly. Debit and credit are non-negative, never both, never neither.
 *   - Reference tokens (Num, bill numbers such as 003/2024.2025, invoice numbers such as INV-7781) found in Num or Memo become
 *     the entry's and the posting's `links`, which is how a later correction in the source is recognised as linked.
 * The output is the `ledger_snapshot` payload the readiness engine reads. The file hash is a synchronous SHA-256 of the text.
 */
export const GL_COLUMNS = ["Account", "Date", "Transaction Type", "Txn Id", "Line", "Num", "Name", "Memo", "Debit", "Credit"] as const;
export const OPENING_TYPE = "Beginning Balance";

export interface GlPosting { id: string; lines: Line[]; links: string[] }
export interface LedgerSnapshotPayload {
  snapshot: string; accounts: Record<string, string>; entries: LedgerEntry[]; postings: GlPosting[]; scope_limited?: boolean;
}
export interface GlOptions {
  file: string; exponent: number; period: { start: string; end: string };
  /** The trial balance's account key for the export's account cell, or undefined when the account is not in the trial balance. */
  accountKeyOf: (cell: string) => string | undefined;
  snapshotId?: string;
}
export interface GlResult { payload: LedgerSnapshotPayload; fileSha256: string; stats: { rows: number; entries: number; accounts: number; postings: number }; accountsWithoutOpening: string[] }

const BILL = /\b\d{1,4}\/\d{4}\.\d{4}\b/g;
const INVOICE = /\b[A-Z]{2,6}-\d{2,}\b/g;
export function referenceTokens(num: string, memo: string): string[] {
  const out: string[] = [];
  const add = (t: string) => { if (t && !out.includes(t)) out.push(t); };
  add(num.trim());
  for (const m of `${num} ${memo}`.matchAll(BILL)) add(m[0]);
  for (const m of `${num} ${memo}`.matchAll(INVOICE)) add(m[0]);
  return out;
}

export function parseGeneralLedgerExport(text: string, opts: GlOptions): GlResult {
  const { file, exponent, period } = opts;
  const t = parseCsv(text, file);
  const ix = requireColumns(t, GL_COLUMNS);
  const openings = new Map<string, bigint>();
  const entries: LedgerEntry[] = [];
  const seen = new Set<string>();
  const byTxn = new Map<string, { lines: Line[]; links: string[]; net: bigint }>();
  const touched: string[] = [];

  for (const r of t.records) {
    const f = r.fields;
    const cell = (n: (typeof GL_COLUMNS)[number]) => f[ix[n]];
    const col = (n: (typeof GL_COLUMNS)[number]) => ix[n] + 1;
    const where = (n: (typeof GL_COLUMNS)[number]) => ({ file, line: r.line, column: col(n) });
    const accountCell = cell("Account").trim();
    if (!accountCell) throw new IntakeError("Account is empty", file, r.line, col("Account"));
    const key = opts.accountKeyOf(accountCell);
    if (key === undefined) throw new IntakeError(`account "${accountCell}" is not in the trial balance`, file, r.line, col("Account"));
    const date = cell("Date").trim();
    if (!isIsoDate(date)) throw new IntakeError(`Date "${date}" is not an ISO date (YYYY-MM-DD)`, file, r.line, col("Date"));
    const debit = parseMinor(cell("Debit"), exponent, where("Debit"), "Debit");
    const credit = parseMinor(cell("Credit"), exponent, where("Credit"), "Credit");
    if (debit > 0n && credit > 0n) throw new IntakeError("a line cannot have both a debit and a credit", file, r.line, col("Debit"));
    const type = cell("Transaction Type").trim();

    if (type === OPENING_TYPE) {
      if (date >= period.start) throw new IntakeError(`opening balance of ${accountCell} is dated ${date}, not before the period starts (${period.start})`, file, r.line, col("Date"));
      if (openings.has(key)) throw new IntakeError(`a second opening balance for account ${accountCell}`, file, r.line, col("Account"));
      openings.set(key, debit - credit);
      continue;
    }
    if (date < period.start || date > period.end) throw new IntakeError(`Date ${date} is outside the period ${period.start} to ${period.end}`, file, r.line, col("Date"));
    if (debit === 0n && credit === 0n) throw new IntakeError("a line needs a debit or a credit", file, r.line, col("Debit"));
    const txn = cell("Txn Id").trim();
    if (!txn) throw new IntakeError("Txn Id is empty", file, r.line, col("Txn Id"));
    const lineNo = cell("Line").trim();
    if (!/^[1-9]\d*$/.test(lineNo)) throw new IntakeError(`Line "${lineNo}" is not a positive whole number`, file, r.line, col("Line"));
    const id = `${txn}#${lineNo}`;
    if (seen.has(id)) throw new IntakeError(`duplicate line ${id}`, file, r.line, col("Txn Id"));
    seen.add(id);
    const num = cell("Num").trim();
    const links = referenceTokens(num, cell("Memo"));
    const amount = (debit - credit).toString();
    const entry: LedgerEntry = { id, date, account: key, amount, links };
    if (num) entry.ref = num;
    entries.push(entry);
    if (!touched.includes(key)) touched.push(key);
    const p = byTxn.get(txn) ?? { lines: [], links: [], net: 0n };
    p.lines.push({ account: key, amount }); p.net += debit - credit;
    for (const l of links) if (!p.links.includes(l)) p.links.push(l);
    byTxn.set(txn, p);
  }
  for (const [txn, p] of byTxn) if (p.net !== 0n) throw new IntakeError(`transaction ${txn} does not balance (difference ${p.net})`, file, 1);

  const accountsWithoutOpening = touched.filter((k) => !openings.has(k)).sort();
  const accounts: Record<string, string> = {};
  for (const k of [...new Set([...openings.keys(), ...touched])].sort()) accounts[k] = (openings.get(k) ?? 0n).toString();
  const fileSha256 = sha256Hex(text);
  const postings: GlPosting[] = [...byTxn].map(([id, p]) => ({ id, lines: p.lines, links: p.links }));
  return {
    payload: { snapshot: opts.snapshotId ?? `gl-${fileSha256.slice(0, 12)}`, accounts, entries, postings },
    fileSha256, accountsWithoutOpening,
    stats: { rows: t.records.length, entries: entries.length, accounts: Object.keys(accounts).length, postings: postings.length },
  };
}
