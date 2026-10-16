/**
 * uploadPolicy.test.ts: the ONE trial balance upload policy — one set of numbers everywhere (server module, browser
 * mirror, drafts migration, accepted types), and the server checks that run before any parse.
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { TB_UPLOAD_POLICY as SERVER, checkSourceBytes, checkSourceBytesActual, checkSourceTables, zipActualExpansion, zipDeclaredSizes } from "../../../supabase/functions/_shared/uploadPolicy";
import { SHEET_ROWS, readSourceTables, readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
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

/** A ZIP with ONE deflated entry whose directory DECLARES `declared` bytes while the data really inflates to `actual`. */
function lyingZip(actual: Buffer, declared: number): Uint8Array {
  const data = zlib.deflateRawSync(actual);
  const name = Buffer.from("xl/worksheets/sheet1.xml");
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(data.length), u32(declared), u16(name.length), u16(0), name, data]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(data.length), u32(declared), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), name]);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  return new Uint8Array(Buffer.concat([local, central, end]));
}

describe("ACTUAL expansion: inflated as a stream and counted; declared sizes are only a first filter", () => {
  it("a package that UNDERSTATES its size passes the declared check but is caught by the real count, cut off at the limit", async () => {
    const b = lyingZip(Buffer.alloc(1_000_000), 10);
    expect(checkSourceBytes(b, "tb.xlsx")).toBeNull(); // the directory claims 10 bytes
    const m = await zipActualExpansion(b, 100_000);
    expect(m.kind === "measured" && m.over && m.total > 100_000 && m.total < 1_000_000).toBe(true); // stopped early
  });
  it("at the policy limit the gate refuses before any reader, whatever the directory says", async () => {
    const b = lyingZip(Buffer.alloc(SERVER.maxExpandedBytes + 1024), 10);
    expect((await checkSourceBytesActual(b, "tb.xlsx"))?.code).toBe("WORKBOOK_TOO_LARGE_EXPANDED");
  });
  it("a real workbook: the actual total equals the declared one and the gate passes", async () => {
    const b = workbook([["Account", "Debit", "Credit"], ["Cash", 10, 0], ["Capital", 0, 10]]);
    const d = zipDeclaredSizes(b), m = await zipActualExpansion(b, SERVER.maxExpandedBytes);
    expect(d.ok && m.kind === "measured" && m.total === d.uncompressed && !m.over).toBe(true);
    expect(await checkSourceBytesActual(b, "tb.xlsx")).toBeNull();
  });
  it("a corrupt deflate stream is unreadable; bytes that are not a ZIP keep their existing behaviour", async () => {
    const b = lyingZip(Buffer.alloc(1000), 1000);
    // The entry's data starts after the 30-byte local header and its 24-byte name; 0xFF is a reserved deflate block type.
    const dataLength = new DataView(b.buffer).getUint32(18, true);
    b.fill(0xff, 54, 54 + dataLength);
    expect((await checkSourceBytesActual(b, "tb.xlsx"))?.code).toBe("UNSUPPORTED_FORMAT");
    expect(await checkSourceBytesActual(new Uint8Array([1, 2, 3, 4]), "tb.xlsx")).toBeNull();
    expect(await checkSourceBytesActual(new TextEncoder().encode("a,b\n1,2\n"), "tb.csv")).toBeNull();
  });
});

describe("rows are bounded DURING the parse (sheetRows), not only after it", () => {
  it("the reader asks the spreadsheet library for at most limit + 1 rows per sheet", () => {
    const seen: unknown[] = [];
    // (SheetJS adds fields to the options object it is given, so the spy records a copy taken before the call.)
    const spy: XlsxLike = { read: (d, o) => { seen.push({ ...o }); return xlsx.read(d, o); }, utils: xlsx.utils };
    readSourceTables(workbook([["Account", "Debit", "Credit"], ["Cash", 1, 0]]), "tb.xlsx", spy);
    readTrialBalanceSource(workbook([["Account", "Debit", "Credit"], ["Cash", 1, 0]]), ctx, spy);
    expect(SHEET_ROWS).toBe(SERVER.maxRows + 1);
    expect(seen).toEqual([{ type: "array", cellDates: false, sheetRows: SHEET_ROWS }, { type: "array", cellDates: false, sheetRows: SHEET_ROWS }]);
  });
});
