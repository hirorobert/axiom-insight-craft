/**
 * The ingestion characterization corpus: every repository trial-balance fixture under several currencies and periods,
 * plus one file per behaviour the automatic path has (totals, dimensions, refusals, encodings, workbooks). Its digests
 * under origin/main's ingestion code are pinned in __fixtures__/ingest-characterization.json; with no layout, the
 * current code must reproduce every digest exactly (ingestCharacterization.test.ts).
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

export interface CorpusCase { name: string; fileName: string; bytes: Uint8Array; periodYear: number | null; currency: string | null }

const FIX = path.join(__dirname, "__fixtures__");
const enc = (s: string) => new TextEncoder().encode(s);

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

const CSV: Record<string, string> = {
  "plain-balanced": "Account Code,Account Name,Debit,Credit\n1000,Cash,1500.00,\n2000,Payables,,1500.00\n",
  "grouped-thousands": "Code,Description,Dr,Cr\n1000,Cash,\"1,234,567.89\",\n3000,Capital,,\"1,234,567.89\"\n",
  "space-groups": "Code,Name,Debit,Credit\n1000,Bank,1 000 000.50,\n2000,Loan,,1 000 000.50\n",
  "parentheses-balance": "Account Code,Account Name,Balance\n1000,Cash,500\n2000,Payables,(500)\n",
  "negative-balance": "Account Code,Account Name,Balance\n1000,Cash,250.25\n2000,Payables,-250.25\n",
  "imbalance": "Account Code,Account Name,Debit,Credit\n1000,Cash,100,\n2000,Payables,,90\n",
  "duplicate-code": "Account Code,Account Name,Debit,Credit\n1000,Cash,100,\n1000,Cash again,,100\n",
  "duplicate-name": "Account Name,Debit,Credit\nCash,100,\nCash,,100\n",
  "dimensions": "Account Code,Account Name,Cost Centre,Debit,Credit\n1000,Cash,HQ,100,\n1000,Cash,Branch,50,\n2000,Payables,HQ,,150\n",
  "grand-total-ok": "Account Code,Account Name,Debit,Credit\n1000,Cash,100,\n2000,Payables,,100\n,Total,100,100\n",
  "grand-total-mismatch": "Account Code,Account Name,Debit,Credit\n1000,Cash,100,\n2000,Payables,,100\n,Total,120,100\n",
  "coded-total-suspect": "Account Code,Account Name,Debit,Credit\n1000,Cash,100,\n2000,Payables,,90\n9999,Total payables,,10\n",
  "malformed": "Account Code,Account Name,Debit,Credit\n1000,Cash,$100,\n2000,Payables,,1.234,56\n",
  "european-text": "Account Code,Account Name,Debit,Credit\n1000,Cash,\"1.234,56\",\n2000,Payables,,\"1.234,56\"\n",
  "precision": "Account Code,Account Name,Debit,Credit\n1000,Cash,10.005,\n2000,Payables,,10.005\n",
  "range": "Account Code,Account Name,Debit,Credit\n1000,Cash,99999999999999999,\n2000,Payables,,99999999999999999\n",
  "balance-mismatch": "Account Code,Account Name,Debit,Credit,Balance\n1000,Cash,100,,90\n2000,Payables,,100,-100\n",
  "missing-code": "Account Code,Account Name,Debit,Credit\n1000,Cash,100,\n,Payables,,100\n",
  "amounts-without-label": "Account Code,Account Name,Debit,Credit\n1000,Cash,100,\n,,,100\n",
  "headings-and-zero": "Account Code,Account Name,Debit,Credit\n,ASSETS,,\n1000,Cash,100,\n1500,Dormant,,\n1600,Zeroed,0,0\n2000,Payables,,100\n",
  "dash-blank": "Account Code,Account Name,Debit,Credit\n1000,Cash,100,-\n2000,Payables,–,100\n",
  "example-rows": "Account Code,Account Name,Debit,Credit\n1000,Example cash,100,\n2000,Payables,,100\n",
  "no-header": "foo,bar\n1,2\n",
  "only-header": "Account Code,Account Name,Debit,Credit\n",
  "ambiguous-years": "Account Code,Account Name,Debit 2023,Credit 2023,Debit 2022,Credit 2022\n1000,Cash,100,,90,\n2000,Payables,,100,,90\n",
  "years-pick-period": "Account Code,Account Name,Debit 2025,Credit 2025,Debit 2024,Credit 2024\n1000,Cash,100,,90,\n2000,Payables,,100,,90\n",
  "closing-balance": "Account Code,Account Name,Opening Balance,Closing Balance\n1000,Cash,10,100\n2000,Payables,-10,-100\n",
  "transaction-listing": "Date,Account Code,Account Name,Debit,Credit\n2025-01-01,1000,Cash,100,\n2025-01-01,2000,Payables,,100\n",
  "preamble-title": "Acme Ltd\nTrial balance for the year ended 31 December 2025\n\nAccount Code,Account Name,Debit,Credit\n1000,Cash,100,\n2000,Payables,,100\n",
  "wrong-year-title": "Trial balance for the year ended 31 December 2019\nAccount Code,Account Name,Debit,Credit\n1000,Cash,100,\n2000,Payables,,100\n",
  "currency-in-title": "Trial balance (USD)\nAccount Code,Account Name,Debit,Credit\n1000,Cash,100,\n2000,Payables,,100\n",
  "semicolon": "Account Code;Account Name;Debit;Credit\n1000;Cash;100;\n2000;Payables;;100\n",
  "tab": "Account Code\tAccount Name\tDebit\tCredit\n1000\tCash\t100\t\n2000\tPayables\t\t100\n",
  "quoted-newline": "Account Code,Account Name,Debit,Credit\n1000,\"Cash\nat bank\",100,\n2000,Payables,,100\n",
  "unterminated-quote": "Account Code,Account Name,Debit,Credit\n1000,\"Cash,100,\n",
  "crlf": "Account Code,Account Name,Debit,Credit\r\n1000,Cash,100,\r\n2000,Payables,,100\r\n",
  "bom": "﻿Account Code,Account Name,Debit,Credit\n1000,Cash,100,\n2000,Payables,,100\n",
  "names-only": "Account Name,Debit,Credit\nCash,100,\nPayables,,100\n",
  "empty": "",
};

export function characterizationCorpus(): CorpusCase[] {
  const out: CorpusCase[] = [];
  for (const f of fs.readdirSync(FIX).filter((n) => n.endsWith(".csv")).sort()) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, f)));
    for (const [currency, periodYear] of [["TZS", 2025], ["KES", 2025], ["UGX", 2025], ["BHD", 2025], ["USD", 2024], ["TZS", null], [null, 2025], ["XAU", 2025]] as const) {
      out.push({ name: `fixture:${f}:${currency}:${periodYear}`, fileName: f, bytes, periodYear, currency });
    }
  }
  for (const [name, text] of Object.entries(CSV)) {
    for (const currency of ["TZS", "JPY", "KWD"]) out.push({ name: `csv:${name}:${currency}`, fileName: `${name}.csv`, bytes: enc(text), periodYear: 2025, currency });
  }
  out.push({ name: "csv:utf16", fileName: "utf16.csv", bytes: new Uint8Array([0xff, 0xfe, 0x41, 0x00]), periodYear: 2025, currency: "TZS" });
  out.push({ name: "csv:latin1", fileName: "latin1.csv", bytes: new Uint8Array([0x41, 0x63, 0x63, 0x6f, 0x75, 0x6e, 0x74, 0xe9, 0x0a]), periodYear: 2025, currency: "TZS" });
  out.push({ name: "pdf:unsupported", fileName: "tb.pdf", bytes: enc("%PDF-1.4"), periodYear: 2025, currency: "TZS" });
  const tb = [["Account Code", "Account Name", "Debit", "Credit"], [1000, "Cash", 1234.56, null], [2000, "Payables", null, 1234.56]];
  const sheets: Record<string, Record<string, unknown[][]>> = {
    "one-sheet": { TB: tb },
    "numbers-float-noise": { TB: [["Account Code", "Account Name", "Debit", "Credit"], [1000, "Cash", 0.1 + 0.2, null], [2000, "Payables", null, 0.3]] },
    "cover-and-tb": { Cover: [["Acme Ltd"], ["Prepared 2025"]], TB: tb },
    "two-tb-sheets": { TB2025: tb, TB2024: tb },
    "no-tb-sheet": { Notes: [["hello"], ["world"]], More: [["x", "y"]] },
    "empty-workbook": { Sheet1: [] },
    "offset-rows": { TB: [[], [], ["Trial balance 2025"], ...tb] },
    "text-amounts": { TB: [["Account Code", "Account Name", "Debit", "Credit"], ["1000", "Cash", "1,000.00", null], ["2000", "Payables", null, "1,000.00"]] },
    "tiny-amount": { TB: [["Account Code", "Account Name", "Debit", "Credit"], [1000, "Cash", 1e-9, null], [2000, "Payables", null, 1e-9]] },
  };
  for (const [name, s] of Object.entries(sheets)) out.push({ name: `xlsx:${name}`, fileName: `${name}.xlsx`, bytes: workbook(s), periodYear: 2025, currency: "TZS" });
  out.push({ name: "xlsx:corrupt", fileName: "corrupt.xlsx", bytes: enc("not a zip"), periodYear: 2025, currency: "TZS" });
  return out;
}

/** A stable digest input: bigint as text, keys in insertion order (the result's own shape). */
export function resultText(r: unknown): string {
  return JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}
