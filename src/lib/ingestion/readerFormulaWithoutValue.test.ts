/**
 * S2-I01 (second-pass audit 2026-11-11): a workbook cell that carries a formula but no calculated (cached) value — written
 * by a library that does not calculate (openpyxl), or a template with uncomputed SUMs — was read as an empty cell, so its
 * row became a zero balance and silently left the trial balance; when the vanished amounts offset, the file still balanced
 * and was certified with accounts missing. Through the exact code process-trial-balance, trial-balance-layout and
 * layout-assist bundle (_shared/tbSource.ts + tbIngestion.ts) and the same SheetJS version (0.18.5). Every workbook is
 * built here, synthetically; expected figures are worked out by hand (TZS, 2 decimals: 1.00 = 100 minor units).
 */
import * as XLSX from "xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MilestoneLog, markIngestionMilestones, type IngestResult } from "../../../supabase/functions/_shared/tbIngestion";
import {
  isOfficeOpenXmlPackage, readSourceTables, readTrialBalanceSource, readTrialBalanceSourceWithLayout, type XlsxLike,
} from "../../../supabase/functions/_shared/tbSource";
import { LAYOUT_TEMPLATE_FORMAT, profileSha256, type LayoutProfile } from "../../../supabase/functions/_shared/layoutProfile";

const xlsx = XLSX as unknown as XlsxLike;
const ctx = (fileName: string) => ({ fileName, periodYear: 2025, currency: "TZS" });
const codes = (r: IngestResult) => r.issues.map((i) => i.code);
const accounts = (r: IngestResult) => r.accounts.map((a) => [a.accountCode, a.debitMinor, a.creditMinor]);

type Cells = Record<string, Record<string, unknown>>;
/** A one-or-more-sheet workbook; `cells` overrides individual cells (formulas) after the rows are laid out. */
function workbook(sheets: Record<string, { rows: unknown[][]; cells?: Cells }>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, s] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    for (const [addr, cell] of Object.entries(s.cells ?? {})) ws[addr] = cell;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
/** Rewrites the first worksheet's XML (to write a cell exactly as another program writes it). */
function patchSheetXml(bytes: Uint8Array, edit: (xml: string) => string): Uint8Array {
  const files = unzipSync(bytes);
  const name = "xl/worksheets/sheet1.xml";
  const before = strFromU8(files[name]);
  const after = edit(before);
  expect(after).not.toBe(before);
  return zipSync({ ...files, [name]: strToU8(after) });
}

// ── I-1 fixture ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Rows 2-3 are typed numbers; rows 4-5 are formulas. With their values: receivables 100,000.00 Dr (= 40 % of 250,000.00)
// and sales 100,000.00 Cr (= C4). Without them, both rows read as empty and offset exactly, so the file still balances.
const FORMULA_ROWS = [
  ["Account Code", "Account Name", "Debit", "Credit"],
  ["1000", "Cash at bank", 250000, null],
  ["3000", "Share capital", null, 250000],
  ["1200", "Trade receivables", null, null],
  ["4000", "Sales", null, null],
];
const UNCALCULATED: Cells = { C4: { t: "n", f: "C2*0.4" }, D5: { t: "n", f: "C4" } };
const CALCULATED: Cells = { C4: { t: "n", f: "C2*0.4", v: 100000 }, D5: { t: "n", f: "C4", v: 100000 } };
const TYPED_ROWS = FORMULA_ROWS.map((r, i) => (i === 3 ? ["1200", "Trade receivables", 100000, null] : i === 4 ? ["4000", "Sales", null, 100000] : r));

describe("I-1: a formula without a calculated value (S2-I01)", () => {
  it("the SheetJS-written fixture really has no cached value: the cells are <f> with no <v>", () => {
    const xml = strFromU8(unzipSync(workbook({ TB: { rows: FORMULA_ROWS, cells: UNCALCULATED } }))["xl/worksheets/sheet1.xml"]);
    expect(xml).toContain('<c r="C4"><f>C2*0.4</f></c>');
    expect(xml).toContain('<c r="D5"><f>C4</f></c>');
  });

  it("is refused by name, naming every such cell, before any row is read as an account", () => {
    const r = readTrialBalanceSource(workbook({ TB: { rows: FORMULA_ROWS, cells: UNCALCULATED } }), ctx("tb.xlsx"), xlsx);
    // Before the fix (hand-worked): accounts 1000 Dr 25,000,000 and 3000 Cr 25,000,000 minor; rows 4 and 5 zero balance;
    // totals 25,000,000 = 25,000,000; no issue — certified with receivables and sales missing.
    expect(r.blocking).toBe(true);
    expect(codes(r)).toEqual(["FORMULA_WITHOUT_VALUE"]);
    const issue = r.issues[0];
    expect(issue.severity).toBe("blocking");
    expect(issue.rows).toEqual([4, 5]);
    expect(issue.message).toContain("C4, D5");
    expect(issue.message).toContain("“TB”");
    expect(issue.message).toMatch(/calculate/i);
    // Nothing was read as an account and no total was formed: there is nothing to certify.
    expect(r.accounts).toEqual([]);
    expect(r.totals).toBeNull();
    expect(r.lineage).toEqual([]);
  });

  it("records the refusal at the 'File read' milestone with its own message (the upload shows it as Blocked)", () => {
    const r = readTrialBalanceSource(workbook({ TB: { rows: FORMULA_ROWS, cells: UNCALCULATED } }), ctx("tb.xlsx"), xlsx);
    const log = new MilestoneLog();
    markIngestionMilestones(log, r);
    expect(log.list().find((m) => m.id === "read")).toMatchObject({ status: "failed", detail: r.issues[0].message });
    expect(log.list().filter((m) => m.status !== "not_reached").map((m) => m.id)).toEqual(["read"]);
  });

  it("is refused as openpyxl writes it (<f> with an empty <v>), in any column of the sheet read, including the title block", () => {
    const base = workbook({ TB: { rows: [["Trial balance FY2025"], [], ...FORMULA_ROWS], cells: { C6: { t: "n", v: 100000 }, D7: { t: "n", v: 100000 } } } });
    // An amount cell, as openpyxl writes a formula (no t attribute, an empty <v/>).
    const amount = readTrialBalanceSource(patchSheetXml(base, (x) => x.replace(/<c r="C6"><v>100000<\/v><\/c>/, '<c r="C6"><f>SUM(C4:C5)</f><v></v></c>')), ctx("tb.xlsx"), xlsx);
    expect(codes(amount)).toEqual(["FORMULA_WITHOUT_VALUE"]);
    expect(amount.issues[0].message).toContain("C6");
    // A name cell and a title-block cell (above the header): an empty value there changes what the reader decides too.
    // (A text formula Excel saved as t="str" reads as its calculated text; with an empty <v> that is "", which SheetJS cannot
    // tell from a missing one — a library that does not calculate writes no t attribute, as here.)
    const name = readTrialBalanceSource(patchSheetXml(base, (x) => x.replace('<c r="B7" t="str"><v>Sales</v></c>', '<c r="B7"><f>"Sa"&amp;"les"</f><v></v></c>')), ctx("tb.xlsx"), xlsx);
    expect(codes(name)).toEqual(["FORMULA_WITHOUT_VALUE"]);
    expect(name.issues[0].message).toContain("B7");
    const title = readTrialBalanceSource(patchSheetXml(base, (x) => x.replace('<c r="A1" t="str"><v>Trial balance FY2025</v></c>', '<c r="A1"><f>"Trial balance FY"&amp;2025</f><v/></c>')), ctx("tb.xlsx"), xlsx);
    expect(codes(title)).toEqual(["FORMULA_WITHOUT_VALUE"]);
    expect(title.issues[0].rows).toEqual([1]);
  });

  it("a workbook saved by Excel (formulas WITH calculated values) reads exactly as the same figures typed in", () => {
    const withFormulas = readTrialBalanceSource(workbook({ TB: { rows: FORMULA_ROWS, cells: CALCULATED } }), ctx("tb.xlsx"), xlsx);
    const typed = readTrialBalanceSource(workbook({ TB: { rows: TYPED_ROWS } }), ctx("tb.xlsx"), xlsx);
    expect(withFormulas).toEqual(typed);
    // Hand-worked: 250,000.00 + 100,000.00 = 350,000.00 each side.
    expect(withFormulas.blocking).toBe(false);
    expect(accounts(withFormulas)).toEqual([["1000", 25000000n, 0n], ["3000", 0n, 25000000n], ["1200", 10000000n, 0n], ["4000", 0n, 10000000n]]);
    expect(withFormulas.totals).toEqual({ debitMinor: 35000000n, creditMinor: 35000000n, differenceMinor: 0n });
  });

  it("a formula whose calculated value is empty text, and cells with formatting but no value, read as before", () => {
    const typed = readTrialBalanceSource(workbook({ TB: { rows: TYPED_ROWS } }), ctx("tb.xlsx"), xlsx);
    // D2 (an empty credit) holds a formula Excel calculated to "" (t="str", empty <v>); C3 carries only a style.
    const patched = patchSheetXml(workbook({ TB: { rows: TYPED_ROWS } }), (x) => x
      .replace('<c r="C2"><v>250000</v></c>', '<c r="C2"><v>250000</v></c><c r="D2" t="str"><f>IF(1,"","")</f><v></v></c>')
      .replace('<c r="B3" t="str"><v>Share capital</v></c>', '<c r="B3" t="str"><v>Share capital</v></c><c r="C3" s="0"/>'));
    expect(readTrialBalanceSource(patched, ctx("tb.xlsx"), xlsx)).toEqual(typed);
  });

  it("only the sheet that is read is inspected: an uncalculated formula on another sheet does not refuse the trial balance", () => {
    const r = readTrialBalanceSource(workbook({
      TB: { rows: TYPED_ROWS },
      Notes: { rows: [["Note"], ["Check"]], cells: { B2: { t: "n", f: "TB!C2-TB!D3" } } },
    }), ctx("tb.xlsx"), xlsx);
    expect(r.blocking).toBe(false);
    expect(r.sheetName).toBe("TB");
    expect(r.totals).toEqual({ debitMinor: 35000000n, creditMinor: 35000000n, differenceMinor: 0n });
  });

  it("keeps the read exactly as before for every other format: only an Office Open XML package is read with stubs", () => {
    const book = () => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(TYPED_ROWS), "TB"); return wb; };
    const as = (bookType: "xlsx" | "xlsm" | "ods" | "biff8") => new Uint8Array(XLSX.write(book(), { type: "array", bookType }) as ArrayBuffer);
    expect(isOfficeOpenXmlPackage(as("xlsx"))).toBe(true);
    expect(isOfficeOpenXmlPackage(as("xlsm"))).toBe(true);
    // OpenDocument is a ZIP too (stubs there would expand repeated empty columns into cells); .xls is not a ZIP.
    expect(isOfficeOpenXmlPackage(as("ods"))).toBe(false);
    expect(isOfficeOpenXmlPackage(as("biff8"))).toBe(false);
    expect(isOfficeOpenXmlPackage(new TextEncoder().encode("Account Code,Debit"))).toBe(false);
    expect(isOfficeOpenXmlPackage(new Uint8Array(0))).toBe(false);
    // The same trial balance as .xls reads to the same accounts and totals as the .xlsx.
    const x = readTrialBalanceSource(as("xlsx"), ctx("tb.xlsx"), xlsx);
    const b = readTrialBalanceSource(as("biff8"), ctx("tb.xls"), xlsx);
    expect(accounts(b)).toEqual(accounts(x));
    expect(b.totals).toEqual(x.totals);
  });

  it("is refused under a confirmed layout too; the layout editor can still open the file", async () => {
    const bytes = workbook({ TB: { rows: FORMULA_ROWS, cells: UNCALCULATED } });
    const profile: LayoutProfile = {
      format: LAYOUT_TEMPLATE_FORMAT, sheet: { kind: "sheet", name: "TB" }, headerRow: 1, numberFormat: "comma_dot", balanceSign: null,
      columns: { accountCode: "Account Code", accountName: "Account Name", debit: "Debit", credit: "Credit", balance: null, dimensions: [] },
    };
    const read = readTrialBalanceSourceWithLayout(bytes, ctx("tb.xlsx"), xlsx, profile, await profileSha256(profile));
    expect(codes(read.result)).toEqual(["FORMULA_WITHOUT_VALUE"]);
    expect(read.resolved).toBeNull();
    expect(read.result.accounts).toEqual([]);
    const tables = readSourceTables(bytes, "tb.xlsx", xlsx);
    expect(tables.ok).toBe(true);
  });
});
