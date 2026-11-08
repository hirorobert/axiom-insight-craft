/**
 * The frozen-export pilot: ONE synthetic entity, one reporting period, one complete bank account.
 *
 * Every number is generated here with exact integer arithmetic, so the trial balance, the General Ledger, the bank statement
 * and the approved prior-year figures tie by construction. The figures of the food-rations case are those of fixture E2 in
 * scripts/acceptance/rfr-v3/cases.mjs. WHAT IS CONSTRUCTED (not real client evidence) is listed in fixtures/README.md.
 *
 * `pilotFiles(options)` returns the five export files as text; the committed fixtures are `pilotFiles({})`. The options
 * build variants for tests (an outstanding cheque; an omitted liability) without committing more files.
 */
import { plainMinor } from "../intake/amount";
import { sha256Hex } from "../intake/sha256";

export const PILOT_PERIOD = { start: "2025-07-01", end: "2026-06-30", currency: "TZS", exponent: 2 } as const;
export const PILOT_BANK_ID = "NMB-40102300487";
export const PILOT_BILL = "003/2024.2025";
export const PILOT_CHEQUE = "001593";
export const PILOT_PAYEE = "ENDUIMET RANGERS ASSOCIATION";
export const PILOT_FOOD = 3351879300n;            // 33,518,793.00
export const PILOT_INVOICE = 425000000n;          // 4,250,000.00 (omitted-liability variant)
export const PILOT_OUTSTANDING = 150000000n;      // 1,500,000.00 (outstanding-cheque variant)

export interface PilotOptions { outstandingCheque?: boolean; omittedLiability?: boolean }
export interface PilotAccount { code: string; name: string }
export const PILOT_ACCOUNTS: readonly PilotAccount[] = [
  { code: "1020", name: "NMB bank" }, { code: "1500", name: "Equipment" }, { code: "2000", name: "Trade payables" }, { code: "2200", name: "Accrued liabilities" },
  { code: "3050", name: "Opening Balance Equity" }, { code: "4000", name: "Revenue" }, { code: "5300", name: "Supplies" }, { code: "5607", name: "Food ration" },
  { code: "9999", name: "Balance of remaining accounts (constructed)" },
];

const m = (txt: string): bigint => {
  const neg = txt.startsWith("-");
  const [w, f = ""] = txt.replace(/^-/, "").replace(/,/g, "").split(".");
  const v = BigInt(w + f.padEnd(2, "0"));
  return neg ? -v : v;
};

interface GlLine { account: string; debit?: bigint; credit?: bigint }
interface GlTxn { id: string; date: string; type: string; num: string; name: string; memo: string; lines: GlLine[] }

export interface PilotModel {
  period: typeof PILOT_PERIOD;
  closings: Record<string, bigint>;
  openings: Record<string, bigint>;
  txns: GlTxn[];
  bank: { opening: bigint; rows: { date: string; description: string; ref: string; amount: bigint; balance: bigint; page: number }[]; pagesTotal: number };
  approved: { line: string; accounts: string[]; amount: bigint; level: string; source: string }[];
}

export function pilotModel(opts: PilotOptions = {}): PilotModel {
  const outstanding = opts.outstandingCheque ? PILOT_OUTSTANDING : 0n;
  const closings: Record<string, bigint> = {
    "1020": m("65,772,218.34") - outstanding, "1500": m("40,000,000.00"), "2000": 0n, "2200": 0n, "3050": m("-305,357,378.30"),
    "4000": m("-250,000,000.00"), "5300": m("12,000,000.00") + outstanding, "5607": m("138,798,548.00"), "9999": 0n,
  };
  closings["9999"] = -Object.values(closings).reduce((a, b) => a + b, 0n);

  const txns: GlTxn[] = [
    { id: `CHQ-${PILOT_CHEQUE}`, date: "2025-07-02", type: "Check", num: PILOT_CHEQUE, name: "Enduimet Rangers Association", memo: `Cheque ${PILOT_CHEQUE}, Enduimet Rangers Association, bill ${PILOT_BILL}`,
      lines: [{ account: "5607", debit: PILOT_FOOD }, { account: "1020", credit: PILOT_FOOD }] },
    { id: "DEP-0615", date: "2026-06-15", type: "Deposit", num: "DEP-0615", name: "Customers", memo: "Customer receipts, banked",
      lines: [{ account: "1020", debit: m("11,240,413.71") }, { account: "4000", credit: m("11,240,413.71") }] },
    ...(opts.outstandingCheque ? [{ id: "CHQ-000777", date: "2026-06-28", type: "Check", num: "000777", name: "Supplier A", memo: "Cheque 000777 issued 28 June, presented after year end",
      lines: [{ account: "5300", debit: PILOT_OUTSTANDING }, { account: "1020", credit: PILOT_OUTSTANDING }] } as GlTxn] : []),
    { id: "JE-FOOD-AGG", date: "2026-06-30", type: "Journal Entry", num: "", name: "", memo: "Food rations, remaining year (constructed aggregate)",
      lines: [{ account: "5607", debit: m("105,279,755.00") }, { account: "9999", credit: m("105,279,755.00") }] },
    { id: "JE-SALES-AGG", date: "2026-06-30", type: "Journal Entry", num: "", name: "", memo: "Sales invoices, year (constructed aggregate)",
      lines: [{ account: "9999", debit: m("238,759,586.29") }, { account: "4000", credit: m("238,759,586.29") }] },
    { id: "JE-SUPPLIES-AGG", date: "2026-06-30", type: "Journal Entry", num: "", name: "", memo: "Supplies, year (constructed aggregate)",
      lines: [{ account: "5300", debit: m("12,000,000.00") }, { account: "9999", credit: m("12,000,000.00") }] },
  ];
  const net: Record<string, bigint> = {};
  for (const t of txns) for (const l of t.lines) net[l.account] = (net[l.account] ?? 0n) + (l.debit ?? 0n) - (l.credit ?? 0n);
  const openings: Record<string, bigint> = {};
  for (const a of PILOT_ACCOUNTS) openings[a.code] = closings[a.code] - (net[a.code] ?? 0n);

  // The bank statement: its opening equals the book opening (no reconciling item carried in). The cheque 000777 of the
  // outstanding-cheque variant is NOT on it (presented after year end), which is what makes it outstanding.
  const bankRows: PilotModel["bank"]["rows"] = [];
  let bal = openings["1020"];
  const push = (date: string, description: string, ref: string, amount: bigint, page: number) => { bal += amount; bankRows.push({ date, description, ref, amount, balance: bal, page }); };
  push("2025-07-02", `CHEQUE ${PILOT_CHEQUE} ${PILOT_PAYEE}`, PILOT_CHEQUE, -PILOT_FOOD, 1);
  push("2026-06-15", "CASH DEPOSIT CUSTOMER RECEIPTS", "DEP-0615", m("11,240,413.71"), 2);

  const approved = [
    { line: "cash", accounts: ["1020"], amount: openings["1020"], level: "account", source: "Approved FY2024/25 statements, cash at bank (constructed)" },
    { line: "equipment", accounts: ["1500"], amount: openings["1500"], level: "account", source: "Approved FY2024/25 statements, equipment at cost (constructed)" },
    { line: "payables-food", accounts: ["2000"], amount: -PILOT_FOOD, level: "subledger", source: `Approved FY2024/25 statements, payables note, bill ${PILOT_BILL}` },
    { line: "remaining", accounts: ["9999"], amount: openings["9999"], level: "account", source: "Approved FY2024/25 statements, remaining balances (constructed)" },
  ];
  return { period: PILOT_PERIOD, closings, openings, txns, bank: { opening: openings["1020"], rows: bankRows, pagesTotal: 2 }, approved };
}

// ── The five export files ──────────────────────────────────────────────────────────────────────────────────────────────
const E = PILOT_PERIOD.exponent;
const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const row = (cells: string[]) => cells.map(q).join(",");
const nameOf = (code: string) => PILOT_ACCOUNTS.find((a) => a.code === code)!.name;
export const glAccountCell = (code: string) => `${code} ${nameOf(code)}`;

export interface PilotFiles { tb: string; gl: string; bank: string; approved: string; evidence: string }

export function pilotFiles(opts: PilotOptions = {}): PilotFiles {
  const M = pilotModel(opts);
  const tb = [row(["Account code", "Account name", "Debit", "Credit"]),
    ...PILOT_ACCOUNTS.map((a) => { const c = M.closings[a.code]; return row([a.code, a.name, c >= 0n ? plainMinor(c, E) : "", c < 0n ? plainMinor(-c, E) : ""]); })].join("\n") + "\n";

  const glHead = row(["Account", "Date", "Transaction Type", "Txn Id", "Line", "Num", "Name", "Memo", "Debit", "Credit"]);
  const opening = PILOT_ACCOUNTS.map((a, i) => { const o = M.openings[a.code]; return row([glAccountCell(a.code), "2025-06-30", "Beginning Balance", "OPENING", String(i + 1), "", "", "Opening balance", o >= 0n ? plainMinor(o, E) : "", o < 0n ? plainMinor(-o, E) : ""]); });
  const entries = M.txns.flatMap((t) => t.lines.map((l, i) => row([glAccountCell(l.account), t.date, t.type, t.id, String(i + 1), t.num, t.name, t.memo, l.debit ? plainMinor(l.debit, E) : "", l.credit ? plainMinor(l.credit, E) : ""])));
  const gl = [glHead, ...opening, ...entries].join("\n") + "\n";

  const bank = [row(["Date", "Description", "Reference", "Debit", "Credit", "Balance", "Page"]),
    ...M.bank.rows.map((r) => row([r.date, r.description, r.ref, r.amount < 0n ? plainMinor(-r.amount, E) : "", r.amount > 0n ? plainMinor(r.amount, E) : "", plainMinor(r.balance, E), String(r.page)]))].join("\n") + "\n";

  const approved = [row(["Line", "Account codes", "Amount", "Level", "Source"]),
    ...M.approved.map((a) => row([a.line, a.accounts.join(";"), plainMinor(a.amount, E), a.level, a.source]))].join("\n") + "\n";

  return { tb, gl, bank, approved, evidence: pilotEvidenceJson(opts) };
}

interface PilotDoc { id: string; kind: string; extraction: "human_confirmed" | "reproduced" | "ai_unconfirmed"; facts: Record<string, string>; file_name: string }
export function pilotEvidence(opts: PilotOptions = {}): PilotDoc[] {
  const food = PILOT_FOOD.toString();
  const docs: PilotDoc[] = [
    { id: "EV-NMB-001593", kind: "bank_statement", extraction: "reproduced", facts: { amount: food, ref: PILOT_CHEQUE, date: "2025-07-02", counterparty: PILOT_PAYEE }, file_name: "bank_nmb_fy2026.csv" },
    { id: "EV-V02-N13", kind: "approved_fs_note", extraction: "human_confirmed", facts: { amount: food, ref: PILOT_BILL }, file_name: "approved_fs_2024_25_note13.pdf" },
    { id: "EV-PV-001593", kind: "payment_voucher", extraction: "human_confirmed", facts: { amount: food, ref: PILOT_BILL }, file_name: "payment_voucher_001593.pdf" },
    { id: "EV-ERA-CONF", kind: "supplier_confirmation", extraction: "human_confirmed", facts: { counterparty: PILOT_PAYEE, ref: PILOT_BILL, amount: food }, file_name: "payee_confirmation.pdf" },
    { id: "EV-OBE-JNL", kind: "opening_journal", extraction: "human_confirmed", facts: { account: "2000", amount: food, date: "2025-06-30", ref: PILOT_BILL }, file_name: "opening_journal.csv" },
    { id: "EV-PAYLIST", kind: "subsequent_payments_listing", extraction: "human_confirmed", facts: { date: "2026-08-14" }, file_name: "payments_listing_to_2026-08-14.csv" },
    { id: "EV-INVREG", kind: "supplier_invoice_register", extraction: "human_confirmed", facts: { date: "2026-08-14" }, file_name: "supplier_invoice_register_to_2026-08-14.csv" },
  ];
  if (opts.omittedLiability) docs.push(
    { id: "EV-INV-7781", kind: "supplier_invoice", extraction: "human_confirmed", facts: { amount: PILOT_INVOICE.toString(), date: "2026-07-14", ref: "INV-7781" }, file_name: "invoice_7781.pdf" },
    { id: "EV-GRN-552", kind: "goods_received_note", extraction: "human_confirmed", facts: { date: "2026-06-24", ref: "552" }, file_name: "grn_552.pdf" });
  if (opts.outstandingCheque) docs.push(
    { id: "EV-JUL-STMT", kind: "bank_statement_subsequent", extraction: "reproduced", facts: { amount: (-PILOT_OUTSTANDING).toString(), ref: "000777", date: "2026-07-03", account: PILOT_BANK_ID }, file_name: "bank_nmb_july_2026.csv" });
  return docs;
}

/** Documents that are not exports in this repository carry a hash of a stable placeholder, never a real file's. */
function pilotEvidenceJson(opts: PilotOptions): string {
  const docs = pilotEvidence(opts).map((d) => ({ id: d.id, kind: d.kind, extraction: d.extraction, facts: d.facts, file_name: d.file_name, file_sha256: sha256Hex(`constructed document ${d.id}`) }));
  return JSON.stringify(docs, null, 2) + "\n";
}

export const PILOT_FILE_NAMES = { tb: "tb_fy2026.csv", gl: "gl_fy2026.csv", bank: "bank_nmb_fy2026.csv", approved: "approved_prior_year.csv", evidence: "evidence.json" } as const;

export const PILOT_README = `# Pilot fixtures: one synthetic entity, FY2025/26

Synthetic and redacted. Nothing here is a real client's record. The figures of the food-rations case are those of fixture E2 in
scripts/acceptance/rfr-v3/cases.mjs; the rest is generated so that every file ties to the others exactly.

Regenerate (and check) with: \`bun scripts/readiness/writePilotFixtures.mjs\` (add \`--check\` to compare without writing).

| File | What it is | Constructed? |
|---|---|---|
| tb_fy2026.csv | Trial balance at 30 June 2026 | The nine accounts are a fixture; account 9999 is a constructed balancing line standing for the rest of the books |
| gl_fy2026.csv | General Ledger export: a Beginning Balance row per account, then the year's entries | CONSTRUCTED. The cheque 001593 posting (Dr food ration, Cr bank) follows the real bank row; the other entries are aggregates. The ledger carries NO opening payable and no equity counterpart for bill ${PILOT_BILL}: that omission is the constructed fact the pilot corrects |
| bank_nmb_fy2026.csv | One complete bank account, 2 pages, running balances chain, no outstanding items | CONSTRUCTED around the real cheque row of 2 July 2025 |
| approved_prior_year.csv | Approved prior-year closing figures per line | CONSTRUCTED except the payable of 33,518,793.00 for bill ${PILOT_BILL}, taken from the approved note in the E2 fixture |
| evidence.json | The documents held and the facts each states | Voucher, payee confirmation, opening journal, payments listing and invoice register are CONSTRUCTED; their hashes are of placeholder text, not of real files |

Amounts are plain decimals (no thousands separators), TZS, two decimals. Debit is positive in the ledger and the trial balance.
On the bank statement a payment is the Debit column (money out) and a receipt the Credit column (money in).
`;
