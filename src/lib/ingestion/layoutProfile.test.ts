/**
 * layout-template/1 (supabase/functions/_shared/layoutProfile.ts): explicit layouts, number formats, resolution against
 * a file and ingestion under a confirmed layout. Golden number-format fixtures are generated from integer minor units
 * and their totals are computed independently here (plain integer sums), never by the code under test.
 */
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import {
  LAYOUT_TEMPLATE_FORMAT, NUMBER_FORMATS, NUMBER_FORMAT_IDS, numberFormatEvidence, parseAmountInFormat, profileSha256,
  resolveLayout, resolvedLayoutSha256, validateProfile, type LayoutProfile, type NumberFormatId,
} from "../../../supabase/functions/_shared/layoutProfile";
import { parseCsvText, type IngestResult } from "../../../supabase/functions/_shared/tbIngestion";
import { readTrialBalanceSource, readTrialBalanceSourceWithLayout, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";

const xlsx = XLSX as unknown as XlsxLike;
const enc = (s: string) => new TextEncoder().encode(s);
const ctx = (fileName: string, currency = "TZS") => ({ fileName, periodYear: 2025, currency });
const codes = (r: IngestResult) => r.issues.map((i) => i.code);

const profile = (over: Partial<LayoutProfile> = {}, columns: Partial<LayoutProfile["columns"]> = {}): LayoutProfile => ({
  format: LAYOUT_TEMPLATE_FORMAT, sheet: { kind: "csv" }, headerRow: 1, numberFormat: "comma_dot", balanceSign: null,
  ...over,
  columns: { accountCode: "Code", accountName: "Name", debit: "Dr", credit: "Cr", balance: null, dimensions: [], ...columns },
});
async function read(text: string, p: LayoutProfile, fileName = "tb.csv", currency = "TZS") {
  return readTrialBalanceSourceWithLayout(enc(text), ctx(fileName, currency), xlsx, p, await profileSha256(p));
}
function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

// ── An independent formatter: integer minor units → text in a number format (test-local, not the code under test) ──
function writeIn(minor: bigint, exponent: number, f: NumberFormatId): string {
  const { group, decimal } = NUMBER_FORMATS[f];
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(exponent + 1, "0");
  const whole = abs.slice(0, abs.length - exponent);
  const frac = exponent ? abs.slice(abs.length - exponent) : "";
  let grouped = "";
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) grouped += group;
    grouped += whole[i];
  }
  const body = grouped + (frac ? decimal + frac : "");
  return neg ? `(${body})` : body;
}
const q = (s: string) => `"${s}"`;

describe("number formats", () => {
  it("reads each declared format exactly; number cells are unaffected", () => {
    expect(parseAmountInFormat("1.234.567,89", 2, "dot_comma")).toEqual({ kind: "amount", minor: 123456789n });
    expect(parseAmountInFormat("1 234 567,89", 2, "space_comma")).toEqual({ kind: "amount", minor: 123456789n });
    expect(parseAmountInFormat("1'234'567.89", 2, "apostrophe_dot")).toEqual({ kind: "amount", minor: 123456789n });
    expect(parseAmountInFormat("1’234.5", 2, "apostrophe_dot")).toEqual({ kind: "amount", minor: 123450n });
    expect(parseAmountInFormat("1 234,50", 2, "space_comma")).toEqual({ kind: "amount", minor: 123450n });
    expect(parseAmountInFormat("(1.000,00)", 2, "dot_comma")).toEqual({ kind: "amount", minor: -100000n });
    expect(parseAmountInFormat("-12,5", 2, "plain_comma")).toEqual({ kind: "amount", minor: -1250n });
    expect(parseAmountInFormat(1234.56, 2, "dot_comma")).toEqual({ kind: "amount", minor: 123456n });
    expect(parseAmountInFormat("—", 2, "dot_comma")).toEqual({ kind: "blank" });
  });

  it("a cell written in another format is a mismatch, not a guess; nonsense stays malformed", () => {
    expect(parseAmountInFormat("1,234.56", 2, "dot_comma").kind).toBe("format");
    expect(parseAmountInFormat("1.234,56", 2, "comma_dot").kind).toBe("format");
    expect(parseAmountInFormat("1,234", 2, "plain_dot").kind).toBe("format");
    expect(parseAmountInFormat("1,2,3", 2, "dot_comma").kind).toBe("malformed");
    expect(parseAmountInFormat("$100", 2, "comma_dot").kind).toBe("malformed");
    expect(parseAmountInFormat("1.234.56", 2, "dot_comma").kind).toBe("malformed");
  });

  it("precision is never rounded under a layout", () => {
    expect(parseAmountInFormat("10,005", 2, "plain_comma")).toMatchObject({ kind: "precision", decimals: 3, text: "10,005" });
    expect(parseAmountInFormat("1.234,5", 0, "dot_comma")).toMatchObject({ kind: "precision" });
  });

  it("evidence says when the choice of format changes a value (ambiguous separators must be chosen explicitly)", () => {
    const amb = numberFormatEvidence(["1.234", "2.500"]);
    expect(amb.ambiguous).toBe(true);
    expect(amb.consistent).toEqual(expect.arrayContaining(["comma_dot", "plain_dot", "dot_comma"]));
    const clear = numberFormatEvidence(["1.234,56", "12,00"]);
    expect(clear.consistent).toEqual(["dot_comma", "plain_comma"].filter((f) => clear.consistent.includes(f as NumberFormatId)));
    expect(clear.ambiguous).toBe(false);
  });
});

describe("golden number-format fixtures (independent totals)", () => {
  const AMOUNTS: { code: string; minor: bigint; side: "dr" | "cr" }[] = [
    { code: "1000", minor: 123456789n, side: "dr" }, { code: "1100", minor: 5n, side: "dr" }, { code: "1200", minor: 100000000000n, side: "dr" },
    { code: "2000", minor: 99999999n, side: "cr" }, { code: "3000", minor: 100023455795n, side: "cr" }, { code: "4000", minor: 1000n, side: "cr" },
  ];
  const expectedDr = AMOUNTS.filter((a) => a.side === "dr").reduce((s, a) => s + a.minor, 0n);
  const expectedCr = AMOUNTS.filter((a) => a.side === "cr").reduce((s, a) => s + a.minor, 0n);

  it("the fixture balances by construction", () => expect(expectedDr).toBe(expectedCr));

  for (const f of NUMBER_FORMAT_IDS) {
    it(`${f}: every row read exactly; totals equal the independent sums`, async () => {
      const csv = "Code,Name,Dr,Cr\n" + AMOUNTS.map((a) => `${a.code},Account ${a.code},${a.side === "dr" ? q(writeIn(a.minor, 2, f)) : ""},${a.side === "cr" ? q(writeIn(a.minor, 2, f)) : ""}`).join("\n") + "\n";
      const { result, resolved } = await read(csv, profile({ numberFormat: f }));
      expect(codes(result)).toEqual([]);
      expect(resolved?.numberFormat).toBe(f);
      expect(result.totals).toEqual({ debitMinor: expectedDr, creditMinor: expectedCr, differenceMinor: 0n });
      for (const a of AMOUNTS) {
        const acc = result.accounts.find((x) => x.accountCode === a.code)!;
        expect(a.side === "dr" ? acc.debitMinor : acc.creditMinor).toBe(a.minor);
      }
    });
  }

  it("a 3-decimal currency in dot_comma (hand-written literals)", async () => {
    const csv = 'Code,Name,Dr,Cr\n1000,Cash,"1.234,567",\n2000,Loan,,"1.000,000"\n3000,Capital,,"234,567"\n';
    const { result } = await read(csv, profile({ numberFormat: "dot_comma" }), "tb.csv", "BHD");
    expect(result.totals).toEqual({ debitMinor: 1234567n, creditMinor: 1234567n, differenceMinor: 0n });
  });

  it("the automatic path refuses the same European file (malformed), so the layout is what makes it readable", () => {
    const csv = 'Code,Name,Dr,Cr\n1000,Cash,"1.234,56",\n2000,Loan,,"1.234,56"\n';
    expect(codes(readTrialBalanceSource(enc(csv), ctx("tb.csv"), xlsx))).toContain("MALFORMED_NUMERIC_VALUE");
  });
});

describe("validateProfile", () => {
  it("accepts a complete layout and returns its canonical form", () => {
    const v = validateProfile({ ...profile(), columns: { ...profile().columns, accountCode: "  Code  " } });
    expect(v.ok && v.profile.columns.accountCode).toBe("Code");
  });
  it("refuses incomplete or contradictory layouts with reasons", () => {
    const bad = (x: unknown) => { const v = validateProfile(x); expect(v.ok).toBe(false); return v.ok ? [] : v.errors; };
    expect(bad(null)).toHaveLength(1);
    expect(bad({ ...profile(), format: "layout-template/2" }).join()).toMatch(/format/);
    expect(bad(profile({}, { accountCode: null, accountName: null })).join()).toMatch(/account code column/);
    expect(bad(profile({}, { credit: null })).join()).toMatch(/together/);
    expect(bad(profile({}, { debit: null, credit: null, balance: "Bal" })).join()).toMatch(/positive balance/);
    expect(bad(profile({ balanceSign: "debit_positive" })).join()).toMatch(/only to a single Balance/);
    expect(bad(profile({}, { accountName: "code" })).join()).toMatch(/only one role/);
    expect(bad({ ...profile(), numberFormat: "auto" }).join()).toMatch(/number format/);
    expect(bad({ ...profile(), headerRow: 0 }).join()).toMatch(/header row/);
    expect(bad({ ...profile(), sourceFileHash: "x" }).join()).toMatch(/Unknown layout field/);
  });
  it("the profile hash ignores key order and carries no file identity", async () => {
    const p = profile();
    const reordered = JSON.parse(JSON.stringify({ columns: p.columns, numberFormat: p.numberFormat, headerRow: p.headerRow, sheet: p.sheet, balanceSign: p.balanceSign, format: p.format }));
    expect(await profileSha256(reordered)).toBe(await profileSha256(p));
    expect(JSON.stringify(p)).not.toMatch(/hash|source/i);
  });
});

describe("resolution and reuse re-validation", () => {
  const base = "Code,Name,Dr,Cr\n1000,Cash,100,\n2000,Loan,,100\n";

  it("resolves to exact positions; the same layout on a re-ordered file resolves differently", async () => {
    const p = profile();
    const h = await profileSha256(p);
    const a = resolveLayout(parseCsvText(base).ok ? (parseCsvText(base) as { rows: never }).rows : [], null, p, h);
    const moved = "Name,Code,Cr,Dr\nCash,1000,,100\nLoan,2000,100,\n";
    const b = resolveLayout((parseCsvText(moved) as { rows: never }).rows, null, p, h);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.resolved.columns).toEqual({ accountCode: 0, accountName: 1, debit: 2, credit: 3, balance: null });
      expect(await resolvedLayoutSha256(a.resolved)).not.toBe(await resolvedLayoutSha256(b.resolved));
    }
  });

  it("header drift (row moved), a missing column and a duplicated header are refused", async () => {
    expect(codes((await read("Title\n" + base, profile())).result)).toEqual(["LAYOUT_COLUMN_NOT_FOUND", "LAYOUT_COLUMN_NOT_FOUND", "LAYOUT_COLUMN_NOT_FOUND", "LAYOUT_COLUMN_NOT_FOUND"]);
    expect(codes((await read("\n" + base, profile())).result)).toEqual(["LAYOUT_HEADER_NOT_FOUND"]);
    expect(codes((await read("Code,Name,Debit,Cr\n1000,Cash,100,\n", profile())).result)).toEqual(["LAYOUT_COLUMN_NOT_FOUND"]);
    expect(codes((await read("Code,Name,Dr,Cr,Cr\n1000,Cash,100,,\n", profile())).result)).toEqual(["LAYOUT_COLUMN_DUPLICATED"]);
  });

  it("a number-format mismatch is refused on reuse, naming the rows", async () => {
    const { result } = await read('Code,Name,Dr,Cr\n1000,Cash,"1,234.56",\n2000,Loan,,"1,234.56"\n', profile({ numberFormat: "dot_comma" }));
    expect(codes(result)).toEqual(["LAYOUT_NUMBER_FORMAT_MISMATCH"]);
    expect(result.issues[0].rows).toEqual([2, 3]);
    expect(result.blocking).toBe(true);
  });

  it("every source row keeps a disposition under a layout", async () => {
    const csv = "Acme\nCode,Name,Dr,Cr\n,ASSETS,,\n1000,Cash,100,\n1500,Dormant,,\n,,,\n2000,Loan,,100\n,Total,100,100\n";
    const { result } = await read(csv, profile({ headerRow: 2 }));
    expect(codes(result)).toEqual([]);
    expect(result.lineage.map((l) => [l.rowNumber, l.disposition])).toEqual([
      [1, "preamble"], [2, "header"], [3, "heading"], [4, "account"], [5, "zero_balance"], [6, "blank"], [7, "account"], [8, "total"],
    ]);
    expect(result.lineageSummary.rowsRead).toBe(8);
  });

  it("a single Balance column with credit-positive signs", async () => {
    const p = profile({ balanceSign: "credit_positive" }, { debit: null, credit: null, balance: "Bal" });
    const { result } = await read("Code,Name,Bal\n1000,Cash,-250\n2000,Loan,250\n", p);
    expect(result.accounts.map((a) => [a.accountCode, a.debitMinor, a.creditMinor])).toEqual([["1000", 25000n, 0n], ["2000", 0n, 25000n]]);
  });

  it("workbooks: the named sheet only; a missing sheet or a CSV layout on a workbook is refused", async () => {
    const tb = [["Code", "Name", "Dr", "Cr"], ["1000", "Cash", 100, null], ["2000", "Loan", null, 100]];
    const bytes = workbook({ Cover: [["x"]], "TB 2025": tb, "TB 2024": tb });
    const p = profile({ sheet: { kind: "sheet", name: "TB 2025" } });
    const ok = await readTrialBalanceSourceWithLayout(bytes, ctx("tb.xlsx"), xlsx, p, await profileSha256(p));
    expect(codes(ok.result)).toEqual([]);
    expect(ok.result.sheetName).toBe("TB 2025");
    // The automatic path refuses this workbook (two trial-balance sheets); the layout resolves it explicitly.
    expect(codes(readTrialBalanceSource(bytes, ctx("tb.xlsx"), xlsx))).toEqual(["MULTIPLE_TRIAL_BALANCE_SHEETS"]);
    const missing = profile({ sheet: { kind: "sheet", name: "TB 2023" } });
    expect(codes((await readTrialBalanceSourceWithLayout(bytes, ctx("tb.xlsx"), xlsx, missing, await profileSha256(missing))).result)).toEqual(["LAYOUT_SHEET_NOT_FOUND"]);
    const csvLayout = profile();
    expect(codes((await readTrialBalanceSourceWithLayout(bytes, ctx("tb.xlsx"), xlsx, csvLayout, await profileSha256(csvLayout))).result)).toEqual(["LAYOUT_SHEET_NOT_FOUND"]);
  });

  it("the period and currency evidence checks still apply under a layout", async () => {
    const { result } = await read("Trial balance for the year ended 31 December 2019\nCode,Name,Dr,Cr\n1000,Cash,100,\n2000,Loan,,100\n", profile({ headerRow: 2 }));
    expect(codes(result)).toContain("PERIOD_MISMATCH");
  });
});
