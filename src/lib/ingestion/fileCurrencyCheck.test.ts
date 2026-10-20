/**
 * The pre-upload currency read (tbCurrencyLabels + fileCurrencyCheck) agrees exactly with the server's check: a conflict is reported for the
 * selected currency iff the server's own reader raises CURRENCY_MISMATCH for it. Invented data only.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { readCurrencyLabels } from "../../../supabase/functions/_shared/tbCurrencyLabels";
import { checkFileCurrency, classifyLabels, describeEvidence, labelsOf, type FileCurrency } from "./fileCurrencyCheck";

const X = XLSX as unknown as XlsxLike;
const detectFileCurrency = (bytes: Uint8Array, name: string, selected: string | null, xlsx: XlsxLike, year: number | null): FileCurrency => {
  const r = readCurrencyLabels(bytes, name, xlsx, year);
  return r.kind === "unread" ? r : classifyLabels(r.labels, selected);
};
const xlsx = (rows: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "TB");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
};
const csv = (text: string) => new TextEncoder().encode(text);
const ACCOUNTS = [["1000", "Invented bank", 100, null], ["3000", "Invented capital", null, 100]];
const FILES: Record<string, { bytes: Uint8Array; name: string }> = {
  headerTzs: { bytes: xlsx([["Code", "Account Name", "Debit TZS", "Credit TZS"], ...ACCOUNTS]), name: "a.xlsx" },
  labelRowTzs: { bytes: xlsx([["Code", "Account Name", "Debit", "Credit"], [null, null, "TZS", "TZS"], ...ACCOUNTS]), name: "b.xlsx" },
  mixed: { bytes: xlsx([["Code", "Account Name", "Debit USD", "Credit TZS"], ...ACCOUNTS]), name: "c.xlsx" },
  none: { bytes: xlsx([["Code", "Account Name", "Debit", "Credit"], ...ACCOUNTS]), name: "d.xlsx" },
  csvKes: { bytes: csv("Code,Account Name,Debit (KES),Credit (KES)\n1000,Invented bank,100,\n3000,Invented capital,,100\n"), name: "e.csv" },
};

describe("parity with the server's check", () => {
  for (const [label, f] of Object.entries(FILES)) {
    for (const selected of ["USD", "TZS", "KES"]) {
      it(`${label} with ${selected}: a conflict or mixed read iff the server refuses CURRENCY_MISMATCH`, () => {
        const server = readTrialBalanceSource(f.bytes, { fileName: f.name, periodYear: 2026, currency: selected }, X);
        const refused = server.issues.some((i) => i.code === "CURRENCY_MISMATCH");
        const read = detectFileCurrency(f.bytes, f.name, selected, X, 2026);
        expect(read.kind === "conflict" || read.kind === "mixed").toBe(refused);
      });
    }
  }
});

describe("what the read says", () => {
  it("header labels and standalone label rows, with their locations", () => {
    const h = detectFileCurrency(FILES.headerTzs.bytes, "a.xlsx", "USD", X, 2026);
    expect(h).toMatchObject({ kind: "conflict", code: "TZS", selected: "USD" });
    expect(describeEvidence(labelsOf(h))).toBe("row 1");
    const r = detectFileCurrency(FILES.labelRowTzs.bytes, "b.xlsx", "TZS", X, 2026);
    expect(r).toMatchObject({ kind: "match", code: "TZS" });
    expect(labelsOf(r).map((l) => `${l.column}${l.row}`)).toEqual(["C2", "D2"]);
  });
  it("mixed labels name every currency; no labels make no claim", () => {
    expect(detectFileCurrency(FILES.mixed.bytes, "c.xlsx", "TZS", X, 2026)).toMatchObject({ kind: "mixed", codes: ["TZS", "USD"] });
    expect(detectFileCurrency(FILES.none.bytes, "d.xlsx", "TZS", X, 2026)).toEqual({ kind: "none" });
  });
  it("the labels never depend on the selected currency (none chosen yet: still read)", () => {
    expect(labelsOf(detectFileCurrency(FILES.csvKes.bytes, "e.csv", null, X, 2026))).toEqual(labelsOf(detectFileCurrency(FILES.csvKes.bytes, "e.csv", "TZS", X, 2026)));
    expect(detectFileCurrency(FILES.csvKes.bytes, "e.csv", null, X, 2026)).toMatchObject({ kind: "conflict", code: "KES", selected: "" });
  });
  it("no period year, an unreadable file or an unsupported format: unread, never a guess", () => {
    expect(detectFileCurrency(FILES.headerTzs.bytes, "a.xlsx", "USD", X, null)).toEqual({ kind: "unread" });
    expect(detectFileCurrency(new Uint8Array([1, 2, 3]), "x.xlsx", "USD", X, 2026)).toEqual({ kind: "unread" });
    expect(detectFileCurrency(FILES.none.bytes, "x.pdf", "USD", X, 2026)).toEqual({ kind: "unread" });
  });
  it("classification is pure and case-insensitive", () => {
    const ev = (code: string, row = 1) => ({ code, row, column: "C" });
    expect(classifyLabels([], "TZS")).toEqual({ kind: "none" });
    expect(classifyLabels([ev("tzs")], "TZS").kind).toBe("match");
    expect(classifyLabels([ev("TZS"), ev("USD", 2)], "TZS")).toMatchObject({ kind: "mixed", codes: ["TZS", "USD"] });
    expect(describeEvidence([ev("A", 3), ev("A", 1), ev("A", 2), ev("A", 9)])).toBe("rows 1, 2, 3…");
  });
});

describe("the browser entry point (lazy reader and workbook library)", () => {
  it("reads a chosen file exactly like the direct read", async () => {
    const f = new File([FILES.headerTzs.bytes], "a.xlsx");
    expect(await checkFileCurrency(f, "USD", 2026)).toEqual(detectFileCurrency(FILES.headerTzs.bytes, "a.xlsx", "USD", X, 2026));
    expect(await checkFileCurrency(new File([FILES.none.bytes], "d.xlsx"), "TZS", null)).toEqual({ kind: "unread" });
  });
});
