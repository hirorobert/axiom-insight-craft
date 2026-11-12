/**
 * CVE-2023-30533 / GHSA-4r6h-8v6p-xvw6 (SheetJS "Prototype Pollution", affected < 0.19.3): reading a crafted workbook
 * pollutes Object.prototype. The trial-balance reader parses customer-uploaded spreadsheets with SheetJS in
 * process-trial-balance, trial-balance-layout and layout-assist; a polluted prototype persists in a warm Edge Function
 * isolate and reaches every object every later request in it creates.
 *
 * The crafted file is built here, synthetically: an ordinary SheetJS-written workbook with one cell comment, whose comment
 * part is then rewritten so the comment names the cell "__proto__" (<comment ref="__proto__">). SheetJS 0.18.5 looks the
 * cell up as sheet["__proto__"] (which is Object.prototype), finds it "present", and attaches the comment list to it:
 * Object.prototype.c becomes an array holding the comment. The read is the repository's real read path
 * (readTrialBalanceSource in _shared/tbSource.ts, with PR #267's options: an Office Open XML package is read with
 * sheetStubs) and the npm package, whose xlsx.mjs is byte-identical to the ESM build the Edge Functions import.
 */
import * as XLSX from "xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { isOfficeOpenXmlPackage, readSourceTables, readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";

const xlsx = XLSX as unknown as XlsxLike;
const ctx = { fileName: "tb.xlsx", periodYear: 2025, currency: "TZS" };
const proto = Object.prototype as Record<string, unknown>;

// A balanced two-account trial balance: Cash 250,000.00 Dr and Share capital 250,000.00 Cr (TZS, 1.00 = 100 minor units).
const ROWS = [
  ["Account Code", "Account Name", "Debit", "Credit"],
  ["1000", "Cash at bank", 250000, null],
  ["3000", "Share capital", null, 250000],
];

/** The workbook with a comment on A1, then the comment part rewritten to name `ref` instead. */
function workbookWithCommentRef(ref: string): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(ROWS);
  (ws.A1 as Record<string, unknown>).c = [{ a: "Preparer", t: "note" }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "TB");
  const files = unzipSync(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer));
  const name = Object.keys(files).find((k) => /^xl\/comments\d*\.xml$/.test(k));
  expect(name, "SheetJS wrote a comments part").toBeDefined();
  const before = strFromU8(files[name as string]);
  expect(before).toContain('<comment ref="A1"');
  if (ref === "A1") return zipSync(files);
  const after = before.replace('ref="A1"', `ref="${ref}"`);
  expect(after).not.toBe(before);
  return zipSync({ ...files, [name as string]: strToU8(after) });
}

afterEach(() => {
  // Never let one case's pollution leak into another (or into the rest of the run).
  delete proto.c;
});

describe("CVE-2023-30533: a crafted workbook does not pollute Object.prototype", () => {
  it("the fixture is an Office Open XML package whose only comment names the cell __proto__", () => {
    const bytes = workbookWithCommentRef("__proto__");
    expect(isOfficeOpenXmlPackage(bytes)).toBe(true);
    const files = unzipSync(bytes);
    const comments = strFromU8(files[Object.keys(files).find((k) => /^xl\/comments\d*\.xml$/.test(k)) as string]);
    expect(comments).toContain('<comment ref="__proto__"');
    expect(comments).not.toContain('ref="A1"');
  });

  it("readTrialBalanceSource leaves Object.prototype untouched and still reads the two accounts", () => {
    expect(Object.prototype.hasOwnProperty.call(proto, "c")).toBe(false);
    const r = readTrialBalanceSource(workbookWithCommentRef("__proto__"), ctx, xlsx);
    expect(Object.prototype.hasOwnProperty.call(proto, "c"), "Object.prototype.c was set by the read").toBe(false);
    expect(({} as Record<string, unknown>).c).toBeUndefined();
    // By hand: 250,000.00 = 25,000,000 minor units on each side; the file balances.
    expect(r.accounts.map((a) => [a.accountCode, a.debitMinor, a.creditMinor])).toEqual([["1000", 25_000_000n, 0n], ["3000", 0n, 25_000_000n]]);
    expect(r.blocking).toBe(false);
  });

  it("the layout read (readSourceTables, trial-balance-layout and layout-assist) leaves Object.prototype untouched", () => {
    const t = readSourceTables(workbookWithCommentRef("__proto__"), "tb.xlsx", xlsx);
    expect(Object.prototype.hasOwnProperty.call(proto, "c"), "Object.prototype.c was set by the read").toBe(false);
    expect(t.ok).toBe(true);
  });

  it("the same workbook with the comment on A1 reads the same accounts (the comment itself is harmless)", () => {
    const r = readTrialBalanceSource(workbookWithCommentRef("A1"), ctx, xlsx);
    expect(Object.prototype.hasOwnProperty.call(proto, "c")).toBe(false);
    expect(r.accounts.map((a) => [a.accountCode, a.debitMinor, a.creditMinor])).toEqual([["1000", 25_000_000n, 0n], ["3000", 0n, 25_000_000n]]);
    expect(r.blocking).toBe(false);
  });
});
