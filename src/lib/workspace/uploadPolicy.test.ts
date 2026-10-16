/**
 * uploadPolicy.test.ts: the ONE trial balance upload policy — one set of numbers everywhere (server module, browser
 * mirror, drafts migration, accepted types), and the server checks that run before any parse.
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { TB_UPLOAD_POLICY as SERVER, checkSourceBytes, checkSourceTables, zipDeclaredSizes } from "../../../supabase/functions/_shared/uploadPolicy";
import { readSourceTables, readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { TB_UPLOAD_POLICY as BROWSER, UPLOAD_LIMITS_TEXT, fileTooLarge } from "./uploadPolicy";
import { ACCEPTED_EXTENSIONS } from "@/lib/ingestion/uploadFlow";

const REPO = path.resolve(__dirname, "../../..");
const xlsx = XLSX as unknown as XlsxLike;
const ctx = { fileName: "tb.xlsx", periodYear: 2026, currency: "TZS" };

/** A minimal, valid ZIP whose central directory DECLARES the given uncompressed sizes (stored entries, no data). */
function forgedZip(sizes: number[]): Uint8Array {
  const parts: number[] = [];
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const local: number[][] = [], central: number[][] = [];
  // (flat() over arrays, never one spread of thousands of entries: that overflows the call stack.)
  let offset = 0;
  sizes.forEach((size, i) => {
    const name = [...new TextEncoder().encode(`xl/part${i}.xml`)];
    const lh = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(size), ...u16(name.length), ...u16(0), ...name];
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]);
    local.push(lh); offset += lh.length;
  });
  const cd = central.flat();
  for (const chunk of [local.flat(), cd, [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(sizes.length), ...u16(sizes.length), ...u32(cd.length), ...u32(offset), ...u16(0)]]) {
    for (const byte of chunk) parts.push(byte);
  }
  return new Uint8Array(parts);
}
function workbook(rows: (string | number)[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "TB");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
const neverRead: XlsxLike = { read: () => { throw new Error("the spreadsheet library must not be called"); }, utils: xlsx.utils };

describe("one policy, one set of numbers", () => {
  it("the browser mirror equals the server module", () => {
    expect(BROWSER.version).toBe(SERVER.version);
    expect([...BROWSER.extensions]).toEqual([...SERVER.extensions]);
    expect(BROWSER.maxFileBytes).toBe(SERVER.maxFileBytes);
  });
  it("the uploader's accepted types are the policy's", () => expect([...ACCEPTED_EXTENSIONS]).toEqual([...SERVER.extensions]));
  it("the drafts migration's size CHECK and reserve guard use exactly the policy's maximum", () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations/20261106100000_trial_balance_drafts.sql"), "utf8");
    const limits = [...sql.matchAll(/file_size\s*(?:<=|>)\s*(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0); // ignores the "> 0" guards
    expect(limits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(limits)).toEqual(new Set([SERVER.maxFileBytes]));
  });
  it("the visible limits text is derived from the policy", () => {
    expect(UPLOAD_LIMITS_TEXT).toBe("CSV or Excel (.csv, .xlsx, .xls), up to 50 MB.");
    expect(fileTooLarge({ name: "a.xlsx", size: SERVER.maxFileBytes })).toBeNull();
    expect(fileTooLarge({ name: "a.xlsx", size: SERVER.maxFileBytes + 1 })).toMatch(/larger than 50 MB/);
  });
});

describe("before any parse: file size and workbook expansion (declared sizes; nothing inflated)", () => {
  it("an over-size file is refused by name of the limit", () => {
    expect(checkSourceBytes(new Uint8Array(SERVER.maxFileBytes + 1), "tb.csv")?.code).toBe("FILE_TOO_LARGE");
    expect(checkSourceBytes(new Uint8Array(10), "tb.csv")).toBeNull();
  });
  it("a real workbook passes, with its true expanded size read from the central directory", () => {
    const b = workbook([["Account", "Debit", "Credit"], ["Cash", 10, 0], ["Capital", 0, 10]]);
    const z = zipDeclaredSizes(b);
    // SheetJS stores entries uncompressed by default, so the declared total is close to (not above) the file size.
    expect(z.ok && z.entries > 3 && z.uncompressed > 0 && z.uncompressed < SERVER.maxExpandedBytes).toBe(true);
    expect(checkSourceBytes(b, "tb.xlsx")).toBeNull();
  });
  it("a workbook declaring more than the expanded limit is refused — and the spreadsheet library is never called", () => {
    const bomb = forgedZip([SERVER.maxExpandedBytes, 1]);
    expect(bomb.byteLength).toBeLessThan(1000);
    expect(checkSourceBytes(bomb, "tb.xlsx")?.code).toBe("WORKBOOK_TOO_LARGE_EXPANDED");
    const r = readTrialBalanceSource(bomb, ctx, neverRead);
    expect(r.blocking).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("WORKBOOK_TOO_LARGE_EXPANDED");
    const t = readSourceTables(bomb, "tb.xlsx", neverRead);
    expect(t.ok === false && t.issue.code).toBe("WORKBOOK_TOO_LARGE_EXPANDED");
  });
  it("too many parts and a ZIP64 marker are refused; bytes that are not a ZIP are left to the existing path (unchanged behaviour)", () => {
    expect(checkSourceBytes(forgedZip(Array(SERVER.maxZipEntries + 1).fill(1)), "tb.xlsx")?.code).toBe("WORKBOOK_TOO_MANY_PARTS");
    expect(checkSourceBytes(new Uint8Array([1, 2, 3, 4]), "tb.xlsx")).toBeNull();
    expect(checkSourceBytes(forgedZip([0xffffffff]), "tb.xlsx")?.code).toBe("WORKBOOK_TOO_LARGE_EXPANDED");
  });
  it(".xlsm is a ZIP and is checked the same way; .xls (not a ZIP) is bounded by size and by the table limits", () => {
    expect(checkSourceBytes(forgedZip([SERVER.maxExpandedBytes + 1]), "tb.xlsm")?.code).toBe("WORKBOOK_TOO_LARGE_EXPANDED");
    expect(checkSourceBytes(forgedZip([SERVER.maxExpandedBytes + 1]), "tb.xls")).toBeNull();
  });
});

describe("after reading, before any check: rows and cells", () => {
  it("limits on rows and cells across every sheet, with a plain next step", () => {
    const row = (n: number) => Array.from({ length: n }, () => null);
    expect(checkSourceTables([{ rows: Array.from({ length: SERVER.maxRows }, () => row(1)) }])).toBeNull();
    expect(checkSourceTables([{ rows: Array.from({ length: SERVER.maxRows }, () => row(1)) }, { rows: [row(1)] }])?.code).toBe("TOO_MANY_ROWS");
    const wide = Array.from({ length: 1000 }, () => row(SERVER.maxCells / 1000 + 1));
    expect(checkSourceTables([{ rows: wide }])?.code).toBe("TOO_MANY_CELLS");
  });
  it("a CSV over the row limit is refused with no result rows (nothing is truncated)", () => {
    const csv = "Account,Debit,Credit\n" + "Cash,1,0\n".repeat(SERVER.maxRows);
    const r = readTrialBalanceSource(new TextEncoder().encode(csv), { ...ctx, fileName: "tb.csv" }, xlsx);
    expect(r.blocking).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("TOO_MANY_ROWS");
  });
});
