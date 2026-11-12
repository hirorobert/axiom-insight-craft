import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseCsv } from "../csv";
import { parseMinor } from "../amount";
import { IntakeError } from "../errors";
import { sha256Hex } from "../sha256";
import { parseGeneralLedgerExport } from "../generalLedger";
import { parseBankStatementExport } from "../bankStatement";
import { parseApprovedFigures } from "../approvedFigures";
import { parseEvidenceRegister } from "../evidenceRegister";

const msg = (fn: () => unknown): string => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(IntakeError); return (e as Error).message; } throw new Error("expected a refusal"); };

describe("sha256", () => {
  it("equals node:crypto on empty, short, block-boundary and multi-block input", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "é€𝄞 ledger\n".repeat(40)]) expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
  });
});

describe("strict CSV", () => {
  it("reads quoted commas, doubled quotes, embedded line breaks, CRLF and a BOM", () => {
    const t = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n', "f.csv");
    expect(t.header).toEqual(["a", "b"]);
    expect(t.records.map((r) => r.fields)).toEqual([["x, y", 'say "hi"'], ["two\nlines", "z"]]);
    expect(t.records.map((r) => r.line)).toEqual([2, 3]);
  });
  it("refuses, with file, line and column", () => {
    expect(msg(() => parseCsv("", "f.csv"))).toBe("f.csv:1: the file is empty");
    expect(msg(() => parseCsv("a,b\n1\n", "f.csv"))).toBe("f.csv:2: has 1 fields, the header has 2");
    expect(msg(() => parseCsv("a,b\n1,2,3\n", "f.csv"))).toBe("f.csv:2: has 3 fields, the header has 2");
    expect(msg(() => parseCsv("a,b\n1,2\n\n3,4\n", "f.csv"))).toBe("f.csv:3: blank line");
    expect(msg(() => parseCsv("a,b\n1,2\n\n", "f.csv"))).toBe("f.csv:3: blank line");
    expect(msg(() => parseCsv("a,b\n1,x\"y\n", "f.csv"))).toBe("f.csv:2:4: stray quote inside a field");
    expect(msg(() => parseCsv('a,b\n1,"x"y\n', "f.csv"))).toBe("f.csv:2:6: text after a closing quote");
    expect(msg(() => parseCsv('a,b\n1,"open\n', "f.csv"))).toBe("f.csv:2: unterminated quote");
    expect(msg(() => parseCsv("a,a\n1,2\n", "f.csv"))).toBe('f.csv:1:2: duplicate column name "a"');
    expect(msg(() => parseCsv("a,\n1,2\n", "f.csv"))).toBe("f.csv:1:2: empty column name");
    expect(msg(() => parseCsv("a,b\r1,2\n", "f.csv"))).toBe("f.csv:1:4: a lone carriage return");
  });
  it("accepts a file without a final line break and a header-only file (callers decide whether that is evidence)", () => {
    expect(parseCsv("a,b\n1,2", "f.csv").records).toHaveLength(1);
    expect(parseCsv("a,b\n", "f.csv").records).toHaveLength(0);
  });
});

describe("exact amounts", () => {
  const w = { file: "f.csv", line: 4, column: 9 };
  it("reads grouped and plain decimals exactly", () => {
    expect(parseMinor("33,518,793.00", 2, w, "Debit")).toBe(3351879300n);
    expect(parseMinor("0.05", 2, w, "Debit")).toBe(5n);
    expect(parseMinor("7", 0, w, "Debit")).toBe(7n);
    expect(parseMinor("", 2, w, "Debit")).toBe(0n);
    expect(parseMinor("-1.50", 2, w, "Balance", { signed: true })).toBe(-150n);
  });
  it("refuses negatives, floats, bad grouping, extra decimals and blanks that must be filled", () => {
    expect(msg(() => parseMinor("-5.00", 2, w, "Debit"))).toBe('f.csv:4:9: Debit "-5.00" is negative; put it in the other column');
    expect(msg(() => parseMinor("1e5", 2, w, "Debit"))).toBe('f.csv:4:9: Debit "1e5" is not a plain decimal amount');
    expect(msg(() => parseMinor("1,23.00", 2, w, "Debit"))).toBe('f.csv:4:9: Debit "1,23.00" is not a plain decimal amount');
    expect(msg(() => parseMinor("1.234", 2, w, "Debit"))).toBe('f.csv:4:9: Debit "1.234" has more than 2 decimal places');
    expect(msg(() => parseMinor("", 2, w, "Balance", { blank: "refuse" }))).toBe("f.csv:4:9: Balance is empty");
  });
});

const GL_HEAD = "Account,Date,Transaction Type,Txn Id,Line,Num,Name,Memo,Debit,Credit\n";
const key = (c: string) => c.split(" ")[0] === "1020" || c.split(" ")[0] === "5607" ? c.split(" ")[0] : undefined;
const glOpts = { file: "gl.csv", exponent: 2, period: { start: "2025-07-01", end: "2026-06-30" }, accountKeyOf: key };
const OPEN = "1020 Bank,2025-06-30,Beginning Balance,OPENING,1,,,Opening,100.00,\n5607 Food,2025-06-30,Beginning Balance,OPENING,2,,,Opening,,100.00\n";

describe("General Ledger export", () => {
  it("reads openings, entries, links and balanced postings", () => {
    const memo = '"Cheque 001593, bill 003/2024.2025"';
    const rows = `5607 Food,2025-07-02,Check,CHQ-1,1,001593,Payee,${memo},30.00,\n1020 Bank,2025-07-02,Check,CHQ-1,2,001593,Payee,${memo},,30.00\n`;
    const r = parseGeneralLedgerExport(GL_HEAD + OPEN + rows, glOpts);
    expect(r.payload.accounts).toEqual({ "1020": "10000", "5607": "-10000" });
    expect(r.payload.entries.map((e) => [e.id, e.account, e.amount, e.ref])).toEqual([["CHQ-1#1", "5607", "3000", "001593"], ["CHQ-1#2", "1020", "-3000", "001593"]]);
    expect(r.payload.entries[0].links).toEqual(["001593", "003/2024.2025"]);
    expect(r.payload.postings).toEqual([{ id: "CHQ-1", lines: [{ account: "5607", amount: "3000" }, { account: "1020", amount: "-3000" }], links: ["001593", "003/2024.2025"] }]);
    expect(r.stats).toEqual({ rows: 4, entries: 2, accounts: 2, postings: 1 });
    expect(r.fileSha256).toHaveLength(64);
    expect(r.payload.snapshot).toBe(`gl-${r.fileSha256.slice(0, 12)}`);
  });
  it("refuses exactly", () => {
    const row = (acct: string, date: string, type: string, txn: string, line: string, d: string, c: string) => `${acct},${date},${type},${txn},${line},,,m,${d},${c}\n`;
    const bad = (rows: string) => msg(() => parseGeneralLedgerExport(GL_HEAD + OPEN + rows, glOpts));
    expect(bad(row("9999 X", "2025-08-01", "Check", "T", "1", "1.00", ""))).toBe('gl.csv:4:1: account "9999 X" is not in the trial balance');
    expect(bad(row("1020 B", "2025-13-01", "Check", "T", "1", "1.00", ""))).toBe('gl.csv:4:2: Date "2025-13-01" is not an ISO date (YYYY-MM-DD)');
    expect(bad(row("1020 B", "2026-07-01", "Check", "T", "1", "1.00", ""))).toBe("gl.csv:4:2: Date 2026-07-01 is outside the period 2025-07-01 to 2026-06-30");
    expect(bad(row("1020 B", "2025-08-01", "Check", "T", "1", "1.00", "1.00"))).toBe("gl.csv:4:9: a line cannot have both a debit and a credit");
    expect(bad(row("1020 B", "2025-08-01", "Check", "T", "1", "", ""))).toBe("gl.csv:4:9: a line needs a debit or a credit");
    expect(bad(row("1020 B", "2025-08-01", "Check", "T", "1", "-1.00", ""))).toBe('gl.csv:4:9: Debit "-1.00" is negative; put it in the other column');
    expect(bad(row("1020 B", "2025-08-01", "Check", "T", "1", "1.001", ""))).toBe('gl.csv:4:9: Debit "1.001" has more than 2 decimal places');
    expect(bad(row("1020 B", "2025-08-01", "Check", "T", "x", "1.00", ""))).toBe('gl.csv:4:5: Line "x" is not a positive whole number');
    expect(bad(row("1020 B", "2025-08-01", "Check", "T", "1", "1.00", "") + row("5607 F", "2025-08-01", "Check", "T", "1", "", "1.00"))).toBe("gl.csv:5:4: duplicate line T#1");
    expect(bad(row("1020 B", "2025-08-01", "Check", "T", "1", "1.00", ""))).toBe("gl.csv:1: transaction T does not balance (difference 100)");
    expect(bad(row("1020 B", "2025-06-30", "Beginning Balance", "O", "3", "1.00", ""))).toBe("gl.csv:4:1: a second opening balance for account 1020 B");
    expect(msg(() => parseGeneralLedgerExport(GL_HEAD + "1020 B,2025-07-01,Beginning Balance,O,1,,,m,1.00,\n", glOpts))).toBe("gl.csv:2:2: opening balance of 1020 B is dated 2025-07-01, not before the period starts (2025-07-01)");
    expect(msg(() => parseGeneralLedgerExport("Account,Date\n", glOpts))).toContain('missing column "Transaction Type"');
  });
  it("is deterministic and lists accounts that had no opening row", () => {
    const text = GL_HEAD + "1020 B,2025-08-01,Check,T,1,,,m,1.00,\n5607 F,2025-08-01,Check,T,2,,,m,,1.00\n";
    const a = parseGeneralLedgerExport(text, glOpts), b = parseGeneralLedgerExport(text, glOpts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.accountsWithoutOpening).toEqual(["1020", "5607"]);
    expect(a.payload.accounts).toEqual({ "1020": "0", "5607": "0" });
  });
});

const BANK_HEAD = "Date,Description,Reference,Debit,Credit,Balance,Page\n";
const bm = { file: "bank.csv", bankId: "B1", from: "2025-07-01", to: "2026-06-30", pagesTotal: 3, exponent: 2 };
describe("bank statement export", () => {
  const ok = BANK_HEAD + "2025-07-02,Cheque,001593,10.00,,90.00,1\n2025-08-01,Deposit,D1,,5.00,95.00,2\n2025-09-01,Charge,,1.00,,94.00,3\n";
  it("signs payments negative and receipts positive, derives the opening and finds no missing page", () => {
    const r = parseBankStatementExport(ok, bm);
    expect(r.statement.opening).toBe("10000");
    expect(r.statement.rows).toEqual([{ date: "2025-07-02", amount: "-1000", balance: "9000", ref: "001593" }, { date: "2025-08-01", amount: "500", balance: "9500", ref: "D1" }, { date: "2025-09-01", amount: "-100", balance: "9400" }]);
    expect(r.statement.pages_missing).toEqual([]);
    expect(r.statement.sha).toBe(r.fileSha256);
    let bal = BigInt(r.statement.opening as string);
    for (const row of r.statement.rows ?? []) { bal += BigInt(row.amount); expect(bal.toString()).toBe(row.balance); }
  });
  it("reports pages no row carries, and does not repair printed balances that do not chain", () => {
    const r = parseBankStatementExport(BANK_HEAD + "2025-07-02,Cheque,001593,10.00,,90.00,1\n2025-08-01,Deposit,D1,,5.00,999.00,3\n", bm);
    expect(r.statement.pages_missing).toEqual([2]);
    expect(r.statement.rows?.[1].balance).toBe("99900");
  });
  it("refuses exactly", () => {
    const bad = (rows: string, meta = bm) => msg(() => parseBankStatementExport(BANK_HEAD + rows, meta));
    expect(bad("")).toBe("bank.csv:1: the statement has no transactions");
    expect(bad("2025-07-02,C,r,10.00,5.00,90.00,1\n")).toBe("bank.csv:2:4: a row cannot be both a debit and a credit");
    expect(bad("2025-07-02,C,r,,,90.00,1\n")).toBe("bank.csv:2:4: a row needs a debit or a credit");
    expect(bad("2025-07-02,C,r,10.00,,,1\n")).toBe("bank.csv:2:6: Balance is empty");
    expect(bad("2025-07-02,C,r,10.00,,90.00,9\n")).toBe("bank.csv:2:7: Page 9 is beyond the 3 pages the statement has");
    expect(bad("2025-07-02,C,r,10.00,,90.00,0\n")).toBe('bank.csv:2:7: Page "0" is not a positive whole number');
    expect(bad("2025-06-01,C,r,10.00,,90.00,1\n")).toBe("bank.csv:2:1: Date 2025-06-01 is outside the statement period 2025-07-01 to 2026-06-30");
    expect(bad("2025-08-02,C,r,10.00,,90.00,1\n2025-08-01,C,r,10.00,,80.00,1\n")).toBe("bank.csv:3:1: rows are not in date order (2025-08-01 after 2025-08-02)");
    expect(bad("2025-07-02,C,r,10.00,,90.00,1\n", { ...bm, pagesTotal: 0 })).toBe("bank.csv:1: pages in the statement (0) must be a whole number of at least 1");
  });
});

describe("approved prior-year figures", () => {
  const HEAD = "Line,Account codes,Amount,Level,Source\n";
  it("reads signed amounts, several accounts and levels", () => {
    const r = parseApprovedFigures(HEAD + 'cash,1020;1021,"1,000.50",account,Approved FS\npayables-food,2000,-33518793.00,subledger,Note 13\n', { file: "a.csv", exponent: 2 });
    expect(r.basis).toBe("external_signed_fs");
    expect(r.lines).toEqual([{ line: "cash", approved: "100050", accounts: ["1020", "1021"], level: "account" }, { line: "payables-food", approved: "-3351879300", accounts: ["2000"], level: "subledger" }]);
    expect(r.sources["payables-food"]).toBe("Note 13");
  });
  it("refuses exactly", () => {
    const bad = (rows: string) => msg(() => parseApprovedFigures(HEAD + rows, { file: "a.csv", exponent: 2 }));
    expect(bad("")).toBe("a.csv:1: no approved figures (a header-only file is not evidence)");
    expect(bad("Cash,1020,1.00,account,S\n")).toBe('a.csv:2:1: Line "Cash" must be lower-case letters, digits and hyphens');
    expect(bad("cash,1020,1.00,account,S\ncash,1021,1.00,account,S\n")).toBe('a.csv:3:1: duplicate line "cash"');
    expect(bad("cash,1020;;1021,1.00,account,S\n")).toBe("a.csv:2:2: Account codes must name at least one account, separated by semicolons");
    expect(bad("cash,1020;1020,1.00,account,S\n")).toBe("a.csv:2:2: an account is named twice in Account codes");
    expect(bad("cash,1020,,account,S\n")).toBe("a.csv:2:3: Amount is empty");
    expect(bad("cash,1020,1.00,total,S\n")).toBe('a.csv:2:4: Level "total" must be one of line, account, subledger, item');
    expect(bad("cash,1020,1.00,account,\n")).toBe("a.csv:2:5: Source is empty: say which approved document the figure comes from");
  });
});

describe("evidence register", () => {
  const doc = (o: Record<string, unknown> = {}) => ({ id: "E1", kind: "payment_voucher", extraction: "human_confirmed", facts: { amount: "100", date: "2026-01-02", ref: "R" }, ...o });
  const reg = (docs: unknown[]) => JSON.stringify(docs);
  it("reads documents, keeps ai_unconfirmed, and hashes the register", () => {
    const r = parseEvidenceRegister(reg([doc(), doc({ id: "E2", extraction: "ai_unconfirmed", file_sha256: "a".repeat(64), file_name: "x.pdf" })]), "e.json");
    expect(Object.keys(r.evidence)).toEqual(["E1", "E2"]);
    expect(r.evidence.E2.extraction).toBe("ai_unconfirmed");
    expect(r.documents[1]).toEqual({ id: "E2", file_name: "x.pdf", file_sha256: "a".repeat(64) });
  });
  it("refuses exactly", () => {
    const bad = (docs: unknown[]) => msg(() => parseEvidenceRegister(reg(docs), "e.json"));
    expect(msg(() => parseEvidenceRegister("{", "e.json"))).toMatch(/^e\.json:1: not valid JSON/);
    expect(bad([])).toBe("e.json:1: the register is empty (an empty register is not evidence)");
    expect(bad([doc(), doc()])).toBe('e.json:2: duplicate id "E1"');
    expect(bad([doc({ extraction: "trusted" })])).toBe('e.json:1: E1: extraction "trusted" must be one of human_confirmed, reproduced, ai_unconfirmed');
    expect(bad([doc({ facts: { amount: "1.50" } })])).toBe('e.json:1: E1: amount "1.50" is not a minor-unit string');
    expect(bad([doc({ facts: { date: "02/01/2026" } })])).toBe('e.json:1: E1: date "02/01/2026" is not an ISO date (YYYY-MM-DD)');
    expect(bad([doc({ facts: { amount: 100 } })])).toBe('e.json:1: E1: fact "amount" must be text');
    expect(bad([doc({ file_sha256: "xyz" })])).toBe("e.json:1: E1: file_sha256 must be 64 lower-case hex digits");
    expect(bad([doc({ kind: "" })])).toBe("e.json:1: E1: kind is required");
    expect(bad([doc({ id: "" })])).toBe("e.json:1: id is required");
  });
});
