import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { columnLetter, normaliseEntityName } from "../../../supabase/functions/_shared/tbIngestion";

// Phase 1 §3.3 (entity confirmation) and §3.4 (period and currency evidence). Invented identities and amounts only.
const BODY = [["NATURAL ACCOUNT", "DESCRIPTION", "DEBIT AMOUNT", "CREDIT AMOUNT"], [null, null, "TZS", "TZS"],
  ["91001", "Service charges", 100, null], ["93001", "Capital", null, 100]];

function read(title: unknown[][], workspaceEntityName?: string | null, body: unknown[][] = BODY) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...title, ...body]), "TB");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  return readTrialBalanceSource(bytes, { fileName: "synthetic.xlsx", periodYear: 2026, currency: "TZS", workspaceEntityName }, XLSX as unknown as XlsxLike);
}

describe("title-block evidence", () => {
  it("records the identifiable entity name, the period text and the currency labels, each with its location", () => {
    const r = read([["MFANO TRADERS LTD"], ["Trial balance for the year ended 30 June 2026"], []]);
    expect(r.evidence.entity).toEqual({ text: "MFANO TRADERS LTD", row: 1, column: "A" });
    expect(r.evidence.period).toEqual([{ text: "Trial balance for the year ended 30 June 2026", row: 2, column: "A" }]);
    expect(r.evidence.currencyLabels.map((c) => [c.code, `${c.column}${c.row}`])).toEqual([["TZS", "C5"], ["TZS", "D5"]]);
    expect(r.issues).toEqual([]);
  });
  it("never treats arbitrary title text as an entity: a report title or a line without an organisational form", () => {
    expect(read([["TRIAL BALANCE REPORT"], ["Accounts listing for management"], []]).evidence.entity).toBeNull();
    expect(read([["Mfano"], []]).evidence.entity).toBeNull();
  });
  it("a print or run date is not period evidence", () => {
    expect(read([["Printed on 15/10/2026"], []]).evidence.period).toEqual([]);
  });
  it("evidence never sets anything: amounts, accounts and blocking are unchanged by it", () => {
    const withTitle = read([["MFANO TRADERS LTD"], ["Year ended 30 June 2026"], []]);
    const without = read([]);
    expect(withTitle.totals).toEqual(without.totals);
    expect(withTitle.accounts.map((a) => a.identity)).toEqual(without.accounts.map((a) => a.identity));
    expect(withTitle.blocking).toBe(false);
  });
});

describe("entity confirmation (§3.3)", () => {
  it("a differing identifiable entity asks the question, with the source text and its location; review only", () => {
    const r = read([["MFANO TRADERS LTD"], []], "Kilele Enterprises Limited");
    expect(r.issues).toEqual([{
      code: "ENTITY_NAME_DIFFERS", severity: "review", rows: [1], field: "entity",
      // The identity a recorded decision binds to (20261118100000): the normalised entity, and the file's own text.
      subject: "mfano traders ltd", fileEntity: "MFANO TRADERS LTD",
      message: "This file names MFANO TRADERS LTD; this workspace is Kilele Enterprises Limited. Same entity? (From your file: “MFANO TRADERS LTD”, cell A1.)",
    }]);
    expect(r.blocking).toBe(false);
  });
  it("the same entity written differently is not a difference (case, punctuation, Limited/Ltd, leading 'The')", () => {
    for (const workspace of ["Mfano Traders Limited", "mfano traders ltd.", "The Mfano Traders Ltd"]) {
      expect(read([["MFANO TRADERS LTD"], []], workspace).issues).toEqual([]);
    }
  });
  it("no comparison without an identifiable title-block entity or without a workspace entity", () => {
    expect(read([["Monthly balances"], []], "Kilele Enterprises Limited").issues).toEqual([]);
    expect(read([["MFANO TRADERS LTD"], []], null).issues).toEqual([]);
    expect(read([["MFANO TRADERS LTD"], []], "  ").issues).toEqual([]);
  });
  it("the comparison reads the title block only, never account rows", () => {
    const body = [...BODY.slice(0, 2), ["91001", "Payable to Kilele Enterprises Limited", 100, null], ["93001", "Capital", null, 100]];
    expect(read([["Monthly balances"], []], "Mfano Traders Ltd", body).issues).toEqual([]);
  });
});

describe("helpers", () => {
  it("columnLetter", () => expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]));
  it("normaliseEntityName", () => expect(normaliseEntityName("The Mfano & Sons Company Limited.")).toBe("mfano and sons co ltd"));
});
