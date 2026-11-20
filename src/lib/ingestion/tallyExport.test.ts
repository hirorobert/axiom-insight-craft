/**
 * The Tally (TallyPrime) trial-balance export adapter (supabase/functions/_shared/tbIngestion.ts, tallyXmlExport.ts,
 * tbSource.ts), on SYNTHETIC fixtures written from Tally's documentation (__fixtures__/tally/README.md,
 * docs/release/tally-export-r1/README.md). Nothing here is evidence of a real export; it pins what the adapter does
 * with the documented shape and that it refuses, by name, everything it cannot prove.
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { TALLY_PREDEFINED_GROUPS, parseAmount, parseTallyAmount, type IngestResult } from "../../../supabase/functions/_shared/tbIngestion";
import { readSourceTables, readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { parseTallyXml, readTallyTrialBalanceXml } from "../../../supabase/functions/_shared/tallyXmlExport";
import { characterizationCorpus } from "./characterizationCorpus";

const FIX = path.join(__dirname, "__fixtures__", "tally");
const xlsx = XLSX as unknown as XlsxLike;
const enc = (s: string) => new TextEncoder().encode(s);
const bytesOf = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const read = (bytes: Uint8Array, fileName: string, periodYear = 2025, currency = "TZS") => readTrialBalanceSource(bytes, { fileName, periodYear, currency }, xlsx);
const readFixture = (name: string, periodYear = 2025) => read(bytesOf(name), name, periodYear);
const readCsv = (text: string, periodYear = 2025) => read(enc(text), "synthetic-tally.csv", periodYear);
const codes = (r: IngestResult) => r.issues.map((i) => `${i.severity}:${i.code}`);
const find = (r: IngestResult, code: string) => r.issues.find((i) => i.code === code);
const lineageAddsUp = (r: IngestResult) => {
  const s = r.lineageSummary;
  return s.preamble + s.header + s.blank + s.heading + s.total + s.zero_balance + s.account + s.rejected === s.rowsRead;
};

const LEDGERS = ["Share Capital", "VAT Payable", "Kariakoo Suppliers Ltd", "Mlimani Wholesalers", "CRDB Bank - Current A/c", "Cash", "Azania Retail", "Kigamboni Stores", "Office Equipment", "Sales - Local", "Purchases - Local", "Rent", "Salaries"];
const TOTAL = 1475000000n; // 1,47,50,000.00 TZS in minor units
const DETAILED = fs.readFileSync(path.join(FIX, "tally-detailed-fy2025.csv"), "utf8");
/** The detailed fixture with one line replaced (matched on its quoted name cell). */
const detailedWith = (name: string, line: string | null) => DETAILED.split("\n").map((l) => (l.startsWith(`"${name}"`) ? line : l)).filter((l): l is string => l !== null).join("\n");

describe("Tally detailed (group-wise) export: groups excluded exactly once, every subtotal and the Grand Total checked", () => {
  const r = readFixture("tally-detailed-fy2025.csv");

  it("reads the 13 ledgers, balanced, with nothing blocking and no group among the accounts", () => {
    expect(r.blocking).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.accounts.map((a) => a.accountName)).toEqual(LEDGERS.map((n) => n));
    expect(r.accounts.every((a) => !a.codeProvided)).toBe(true);
    expect(r.totals).toEqual({ debitMinor: TOTAL, creditMinor: TOTAL, differenceMinor: 0n });
    for (const g of ["Capital Account", "Current Assets", "Bank Accounts", "Sundry Debtors", "Indirect Expenses"]) {
      expect(r.accounts.some((a) => a.accountName === g)).toBe(false);
    }
  });

  it("records the detection as provenance, like the QuickBooks Desktop adapter", () => {
    expect(r.columns).toMatchObject({ account_name: "Particulars", debit: "Debit", credit: "Credit", source: "Tally trial balance export (Debit / Credit columns)" });
  });

  it("gives every group line and the Grand Total a 'total' disposition with the check it passed, and the lineage adds up", () => {
    expect(lineageAddsUp(r)).toBe(true);
    const totals = r.lineage.filter((l) => l.disposition === "total");
    expect(totals).toHaveLength(13); // 12 group lines + Grand Total
    expect(totals.filter((l) => /^Tally group subtotal/.test(l.reason ?? ""))).toHaveLength(12);
    const currentAssets = totals.find((l) => l.rowNumber === 14);
    // Current Assets holds three sub-groups whose four ledgers roll up to it; the sub-groups themselves are not counted.
    expect(currentAssets?.reason).toBe("Tally group subtotal “Current Assets”: equals the total of its 4 ledgers; excluded from the accounts");
    expect(currentAssets).toMatchObject({ debitMinor: 480000000n, creditMinor: 0n });
    expect(totals[totals.length - 1]).toMatchObject({ rowNumber: 31, reason: "Tally Grand Total: equals the ledger lines; checked, excluded from the accounts", debitMinor: TOTAL, creditMinor: TOTAL });
    expect(r.lineageSummary).toMatchObject({ rowsRead: 31, preamble: 3, header: 1, blank: 1, total: 13, account: 13, rejected: 0 });
  });

  it("reads Indian lakh grouping inside the adapter only; the generic grammar still refuses it", () => {
    expect(r.accounts.find((a) => a.accountName === "Sales - Local")?.creditMinor).toBe(850000000n);
    expect(parseAmount("1,00,000.00", 2)).toEqual({ kind: "malformed", text: "1,00,000.00" });
  });

  it("a group whose amount is not the sum of its ledgers is refused as a total-row mismatch, naming the group and both readings", () => {
    const bad = readCsv(detailedWith("  Sundry Creditors", '"  Sundry Creditors",,"9,00,000.00"'));
    expect(bad.blocking).toBe(true);
    expect(codes(bad)).toEqual(["blocking:TOTAL_ROW_MISMATCH"]);
    expect(find(bad, "TOTAL_ROW_MISMATCH")?.message).toBe("The Tally group “Sundry Creditors” on row 11 shows debit 0.00, credit 900000.00, but the 2 ledgers beneath it total debit 0.00, credit 1000000.00 (net 1000000.00 Cr). A ledger may be missing, hidden or edited — export the Trial Balance again from Tally with all levels expanded and upload that file.");
    // Ledgers are still read exactly; nothing was repaired or summed with the group.
    expect(bad.accounts).toHaveLength(13);
    expect(bad.totals?.differenceMinor).toBe(0n);
  });

  it("a nested parent is checked against every ledger beneath it, not against its child groups' printed lines", () => {
    // Current Liabilities = Duties & Taxes (2,50,000) + Sundry Creditors (10,00,000) via their ledgers. Break a leaf: the
    // parent AND the child group both mismatch, each named on its own row.
    const bad = readCsv(detailedWith("    VAT Payable", '"    VAT Payable",,"2,00,000.00"'));
    expect(bad.issues.filter((i) => i.code === "TOTAL_ROW_MISMATCH").map((i) => i.rows)).toEqual([[9], [8], [31]]);
  });

  it("accepts a group reported net (Nett Debit/Credit Balances for Reporting) and says so", () => {
    // Sundry Debtors: 12,00,000 Dr + 5,00,000 Dr + 1,00,000 Cr → net 16,00,000 Dr on the group line.
    // Sales are 1,00,000 lower so the ledgers still balance; the top-level lines (and Tally's Grand Total of them) then
    // sum to 1,46,50,000 while the ledgers' gross totals stay 1,47,50,000.
    const net = DETAILED
      .replace('"  Sundry Debtors","17,00,000.00",', '"  Sundry Debtors","16,00,000.00",')
      .replace('"    Kigamboni Stores","5,00,000.00",', '"    Kigamboni Stores","5,00,000.00",\n"    Customer advances",,"1,00,000.00"')
      .replace('"Current Assets","48,00,000.00",', '"Current Assets","47,00,000.00",')
      .replace('"Sales Accounts",,"85,00,000.00"', '"Sales Accounts",,"84,00,000.00"')
      .replace('"  Sales - Local",,"85,00,000.00"', '"  Sales - Local",,"84,00,000.00"')
      .replace('"Grand Total","1,47,50,000.00","1,47,50,000.00"', '"Grand Total","1,46,50,000.00","1,46,50,000.00"');
    const r2 = readCsv(net);
    expect(r2.accounts).toHaveLength(14);
    const sd = r2.lineage.find((l) => l.rowNumber === 19);
    expect(sd?.reason).toBe("Tally group subtotal “Sundry Debtors”: equals the net balance of its 3 ledgers; excluded from the accounts");
    // The Grand Total printed from net group lines is accepted by the top-level reading; the ledgers themselves balance.
    expect(find(r2, "TOTAL_ROW_MISMATCH")).toBeUndefined();
    expect(r2.lineage.find((l) => l.rowNumber === 32)?.reason).toBe("Tally Grand Total: equals the top-level lines (groups reported net); checked, excluded from the accounts");
    expect(r2.totals).toEqual({ debitMinor: TOTAL, creditMinor: TOTAL, differenceMinor: 0n });
    expect(r2.blocking).toBe(false);
  });

  it("a repeated ledger name is refused as today (codeless ledgers keep the name identity)", () => {
    const dup = readCsv(detailedWith("  Salaries", '"  Rent","7,50,000.00",'));
    expect(dup.blocking).toBe(true);
    expect(codes(dup)).toContain("blocking:DUPLICATE_ACCOUNT_NAME");
    expect(find(dup, "DUPLICATE_ACCOUNT_NAME")?.rows).toEqual([29, 30]);
  });

  it("a ledger whose name reads like a total is still a ledger under the adapter", () => {
    const r2 = readCsv(detailedWith("  Salaries", '"  Salaries total","7,50,000.00",'));
    expect(r2.blocking).toBe(false);
    expect(r2.accounts.map((a) => a.accountName)).toContain("Salaries total");
  });

  it("the Grand Total is required and must equal the ledgers", () => {
    const missing = readCsv(detailedWith("Grand Total", null));
    expect(codes(missing)).toEqual(["blocking:UNSUPPORTED_LAYOUT"]);
    expect(find(missing, "UNSUPPORTED_LAYOUT")?.message).toMatch(/no Grand Total row/);
    const wrong = readCsv(detailedWith("Grand Total", '"Grand Total","1,47,50,000.00","1,47,50,001.00"'));
    expect(codes(wrong)).toEqual(["blocking:TOTAL_ROW_MISMATCH"]);
    expect(find(wrong, "TOTAL_ROW_MISMATCH")?.message).toMatch(/^The Grand Total on row 31 \(debit 14750000\.00, credit 14750001\.00\) does not equal the 13 ledger lines/);
  });

  it("a group line without its ledgers (a sub-ledger group, or a condensed group) refuses the file instead of becoming an account", () => {
    // Sundry Debtors shown as one line with its two debtors removed: a predefined group at depth 1 with no ledgers.
    const subLedger = readCsv(detailedWith("    Azania Retail", null).split("\n").filter((l) => !l.startsWith('"    Kigamboni Stores"')).join("\n"));
    expect(codes(subLedger)).toContain("blocking:UNSUPPORTED_LAYOUT");
    expect(find(subLedger, "UNSUPPORTED_LAYOUT")?.message).toBe("Row 19 (“Sundry Debtors”) is a Tally group line with no ledgers beneath it, so its ledgers are not in the file. In Tally, set “Expand all levels in Detailed format” to Yes (and “Group behaves like a sub-ledger” to No for those groups), export the Trial Balance again, and upload that file.");
    expect(subLedger.accounts.some((a) => a.accountName === "Sundry Debtors")).toBe(false);
    expect(subLedger.lineage.find((l) => l.rowNumber === 19)).toMatchObject({ disposition: "rejected", debitMinor: 170000000n });
    // A top-level line with no ledgers beneath it (a user-defined group left condensed) is refused the same way.
    const condensedTop = readCsv(detailedWith("Fixed Assets", '"Plant and machinery","20,00,000.00",').split("\n").filter((l) => !l.startsWith('"  Office Equipment"')).join("\n"));
    expect(find(condensedTop, "UNSUPPORTED_LAYOUT")?.rows).toEqual([22]);
  });

  it("the predefined 'Profit & Loss A/c' ledger is the one top-level leaf that is a ledger", () => {
    const pl = DETAILED
      .replace('"Capital Account",,"50,00,000.00"', '"Profit & Loss A/c",,"5,00,000.00"\n"Capital Account",,"45,00,000.00"')
      .replace('"  Share Capital",,"50,00,000.00"', '"  Share Capital",,"45,00,000.00"');
    const r2 = readCsv(pl);
    expect(r2.blocking).toBe(false);
    expect(r2.accounts.map((a) => a.accountName)).toContain("Profit & Loss A/c");
    expect(r2.totals?.differenceMinor).toBe(0n);
  });

  it("a 'Difference in opening balances' line is an imbalance, not an account", () => {
    const diff = readCsv(detailedWith("Indirect Expenses", '"Difference in opening balances","1,000.00",\n"Indirect Expenses","19,50,000.00",'));
    expect(codes(diff)).toContain("blocking:TRIAL_BALANCE_IMBALANCE");
    expect(find(diff, "TRIAL_BALANCE_IMBALANCE")?.message).toMatch(/Tally's “Difference in opening balances” line/);
    expect(diff.accounts.some((a) => /difference/i.test(a.accountName))).toBe(false);
  });

  it("indentation that does not line up with a group above refuses the file", () => {
    const odd = readCsv(detailedWith("    Mlimani Wholesalers", '"   Mlimani Wholesalers",,"3,00,000.00"'));
    expect(codes(odd)).toContain("blocking:UNSUPPORTED_LAYOUT");
    expect(find(odd, "UNSUPPORTED_LAYOUT")?.message).toMatch(/^Row 13 is indented in a way that does not line up/);
  });

  it("flattened indentation (the CSV saved without quoting) is refused as a group-wise export, never summed twice", () => {
    const flat = DETAILED.replace(/^"\s+/gm, '"');
    const r2 = readCsv(flat);
    expect(r2.blocking).toBe(true);
    expect(codes(r2)).toContain("blocking:UNSUPPORTED_LAYOUT");
    expect(find(r2, "UNSUPPORTED_LAYOUT")?.message).toMatch(/name Tally's predefined groups “Capital Account”, “Current Liabilities”, “Duties & Taxes”/);
    expect(r2.accounts.length).toBeLessThan(26);
  });

  it("checks Tally's period line against the selected year", () => {
    expect(readFixture("tally-detailed-fy2025.csv", 2024).issues.map((i) => i.code)).toContain("PERIOD_MISMATCH");
    expect(find(readFixture("tally-detailed-fy2025.csv", 2024), "PERIOD_MISMATCH")?.message).toBe("The Tally export is for 1-Jan-2025 to 31-Dec-2025, but this trial balance is being uploaded for 2024. Upload the 2024 export, or open the workspace for the year the file belongs to.");
    expect(r.evidence.period.map((p) => p.text)).toContain("1-Jan-2025 to 31-Dec-2025");
    expect(r.evidence.entity?.text).toBe("Mfano Traders Limited");
  });

  it("amounts with more decimals than the currency are still refused, exactly as elsewhere", () => {
    const r2 = readCsv(detailedWith("  Rent", '"  Rent","12,00,000.005",'));
    expect(codes(r2)).toContain("blocking:PRECISION_EXCEEDS_CURRENCY");
  });
});

describe("Tally workbook export: two-row header and number cells", () => {
  const r = readFixture("tally-detailed-fy2025.xlsx");
  it("is detected with the Debit / Credit row beneath 'Closing Balance' and reads the same 13 ledgers", () => {
    expect(r.blocking).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.columns).toMatchObject({ account_name: "Particulars", debit: "Debit", credit: "Credit", source: "Tally trial balance export (Closing Balance: Debit / Credit columns)" });
    expect(r.columns.balance).toBeUndefined();
    expect(r.accounts.map((a) => a.accountName)).toEqual(LEDGERS);
    expect(r.totals).toEqual({ debitMinor: TOTAL, creditMinor: TOTAL, differenceMinor: 0n });
    expect(r.sheetName).toBe("Trial Balance");
  });
  it("accounts for both header rows and every group line in the lineage", () => {
    expect(lineageAddsUp(r)).toBe(true);
    expect(r.lineageSummary).toMatchObject({ rowsRead: 32, header: 2, total: 13, account: 13, rejected: 0 });
    expect(r.lineage.filter((l) => l.disposition === "header").map((l) => l.rowNumber)).toEqual([5, 6]);
  });
});

describe("Tally ledger-wise exports", () => {
  it("a flat list of ledgers with a Grand Total is read as plain ledgers", () => {
    const r = readFixture("tally-ledgerwise-fy2025.csv");
    expect(r.blocking).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.columns.source).toBe("Tally trial balance export (Debit / Credit columns)");
    expect(r.accounts.map((a) => a.accountName)).toEqual(LEDGERS);
    expect(r.totals).toEqual({ debitMinor: TOTAL, creditMinor: TOTAL, differenceMinor: 0n });
    expect(r.lineage[r.lineage.length - 1]).toMatchObject({ disposition: "total", reason: "Tally Grand Total: equals the ledger lines; checked, excluded from the accounts" });
  });

  it("a condensed group-wise export (predefined group names, no indentation) is refused, never read as 'ledgers'", () => {
    const condensed = readCsv([
      "Mfano Traders Limited,,", "Trial Balance,,", "1-Jan-2025 to 31-Dec-2025,,", ",,", "Particulars,Debit,Credit",
      'Capital Account,,"50,00,000.00"', 'Current Liabilities,,"12,50,000.00"', 'Current Assets,"48,00,000.00",', 'Fixed Assets,"20,00,000.00",',
      'Sales Accounts,,"85,00,000.00"', 'Purchase Accounts,"60,00,000.00",', 'Indirect Expenses,"19,50,000.00",', 'Grand Total,"1,47,50,000.00","1,47,50,000.00"',
    ].join("\n"));
    expect(condensed.blocking).toBe(true);
    expect(codes(condensed)).toEqual(["blocking:UNSUPPORTED_LAYOUT"]);
    expect(find(condensed, "UNSUPPORTED_LAYOUT")?.message).toMatch(/^Rows 6, 7, 8, 9, 10, 11, 12 name Tally's predefined groups .* press F5 \(Ledger-wise\)/);
    expect(condensed.accounts).toEqual([]);
    expect(condensed.lineageSummary.rejected).toBe(7);
  });

  it("a single Closing Balance column is read with its Dr/Cr suffix", () => {
    const r = readFixture("tally-closing-drcr-fy2025.csv");
    expect(r.blocking).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.columns).toMatchObject({ account_name: "Particulars", balance: "Closing Balance", source: "Tally trial balance export (Closing Balance with Dr/Cr)" });
    expect(r.accounts.find((a) => a.accountName === "Share Capital")).toMatchObject({ debitMinor: 0n, creditMinor: 500000000n });
    expect(r.accounts.find((a) => a.accountName === "Cash")).toMatchObject({ debitMinor: 10000000n, creditMinor: 0n });
    expect(r.totals).toEqual({ debitMinor: TOTAL, creditMinor: TOTAL, differenceMinor: 0n });
  });

  it("in a Closing Balance column an amount without Dr/Cr cannot be read, and the message says so in Tally's terms", () => {
    const text = fs.readFileSync(path.join(FIX, "tally-closing-drcr-fy2025.csv"), "utf8").replace('"1,00,000.00 Dr"', '"1,00,000.00"');
    const r = readCsv(text);
    expect(codes(r)).toContain("blocking:MALFORMED_NUMERIC_VALUE");
    expect(find(r, "MALFORMED_NUMERIC_VALUE")?.message).toBe("Some amounts are not numbers: row 11 balance “1,00,000.00”. In a Tally Closing Balance column each amount carries its side, for example 1,00,000.00 Dr or 25,000.00 Cr; an amount without Dr/Cr, or a negative one, cannot be read.");
  });

  it("a Dr/Cr suffix inside Debit / Credit columns is not read either", () => {
    const r = readCsv(detailedWith("  Rent", '"  Rent","12,00,000.00 Dr",'));
    expect(codes(r)).toContain("blocking:MALFORMED_NUMERIC_VALUE");
    expect(find(r, "MALFORMED_NUMERIC_VALUE")?.message).toMatch(/Tally amounts are read as plain digits, 1,00,000\.00 or 100,000\.00/);
  });
});

describe("parseTallyAmount: Tally's own writing, nothing else", () => {
  const dc = (s: string) => parseTallyAmount(s, 2, "debit_credit", "debit");
  const cb = (s: string) => parseTallyAmount(s, 2, "closing_drcr", "balance");
  it("Indian, international and plain grouping read to the same exact minor units", () => {
    expect(dc("1,00,000.00")).toEqual({ kind: "amount", minor: 10000000n });
    expect(dc("100,000.00")).toEqual({ kind: "amount", minor: 10000000n });
    expect(dc("100000")).toEqual({ kind: "amount", minor: 10000000n });
    expect(dc("1,47,50,000.00")).toEqual({ kind: "amount", minor: 1475000000n });
    expect(dc("12,345.5")).toEqual({ kind: "amount", minor: 1234550n });
  });
  it("(-) and - are negatives; a Dr/Cr suffix sets the side in the Closing Balance column", () => {
    expect(dc("(-)5,000.00")).toEqual({ kind: "amount", minor: -500000n });
    expect(dc("-5,000.00")).toEqual({ kind: "amount", minor: -500000n });
    expect(cb("5,000.00 Dr")).toEqual({ kind: "amount", minor: 500000n });
    expect(cb("5,000.00 Cr")).toEqual({ kind: "amount", minor: -500000n });
    expect(cb("5,000.00 cr.")).toEqual({ kind: "amount", minor: -500000n });
  });
  it("refuses wrong grouping, a negative with a side, a side in a Debit column, and precision beyond the currency", () => {
    for (const bad of ["10,0000.00", "1,000,00.00", "1.000,00", "TZS 5,000.00", "5,000.00-", "5 000.00"]) expect(dc(bad)).toEqual({ kind: "malformed", text: bad });
    expect(cb("(-)5,000.00 Dr")).toEqual({ kind: "malformed", text: "(-)5,000.00 Dr" });
    expect(cb("5,000.00")).toEqual({ kind: "malformed", text: "5,000.00" });
    expect(dc("5,000.00 Dr")).toEqual({ kind: "malformed", text: "5,000.00 Dr" });
    expect(dc("5,000.005")).toEqual({ kind: "precision", text: "5,000.005", decimals: 3 });
    expect(dc("")).toEqual({ kind: "blank" });
    expect(dc("-")).toEqual({ kind: "blank" });
  });
  it("number cells are read exactly as the generic path reads them", () => {
    expect(parseTallyAmount(1234.5, 2, "debit_credit", "debit")).toEqual({ kind: "amount", minor: 123450n });
  });
  it("the predefined-group list is Tally's 28, normalised", () => {
    expect(TALLY_PREDEFINED_GROUPS.size).toBe(28);
    expect(TALLY_PREDEFINED_GROUPS.has("sundry debtors")).toBe(true);
    expect(TALLY_PREDEFINED_GROUPS.has("cashinhand")).toBe(true);
    expect(TALLY_PREDEFINED_GROUPS.has("cash")).toBe(false);
  });
});

describe("Tally XML export (the documented ENVELOPE of DSPACCNAME / DSPACCINFO pairs)", () => {
  const r = readFixture("tally-trial-balance-fy2025.xml");

  it("reads the ledgers with Tally's signs (debit negative, credit positive) and records the source", () => {
    expect(r.blocking).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.columns).toEqual({ account_name: "Particulars", debit: "Debit", credit: "Credit", source: "Tally XML export (Trial Balance envelope), read as a ledger-wise export" });
    expect(r.accounts.map((a) => a.accountName)).toEqual(LEDGERS);
    expect(r.accounts.find((a) => a.accountName === "CRDB Bank - Current A/c")).toMatchObject({ debitMinor: 300000000n, creditMinor: 0n });
    expect(r.accounts.find((a) => a.accountName === "Share Capital")).toMatchObject({ debitMinor: 0n, creditMinor: 500000000n });
    expect(r.totals).toEqual({ debitMinor: TOTAL, creditMinor: TOTAL, differenceMinor: 0n });
    expect(r.sheetName).toBeNull();
  });

  it("row numbers are the text lines of the file, so a finding points into it", () => {
    expect(r.lineage[0]).toMatchObject({ rowNumber: 1, disposition: "header" });
    expect(r.accounts.map((a) => a.sourceRowNumber)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26]);
    expect(lineageAddsUp(r)).toBe(true);
  });

  it("a positive closing debit (or negative credit) contradicts Tally's convention and is refused, never flipped", () => {
    const text = fs.readFileSync(path.join(FIX, "tally-trial-balance-fy2025.xml"), "utf8");
    const flipped = read(enc(text.replace("<DSPCLDRAMTA>-100000.00</DSPCLDRAMTA>", "<DSPCLDRAMTA>100000.00</DSPCLDRAMTA>")), "tb.xml");
    expect(codes(flipped)).toEqual(["blocking:MALFORMED_NUMERIC_VALUE"]);
    expect(find(flipped, "MALFORMED_NUMERIC_VALUE")?.message).toBe("Some amounts are not numbers: row 12 debit “100000.00”. In a Tally XML export a closing debit is written as a negative amount and a closing credit as a positive one; an amount on the other side cannot be read. Export the Trial Balance again from Tally and upload that file.");
    const negCredit = read(enc(text.replace("<DSPCLCRAMTA>250000.00</DSPCLCRAMTA>", "<DSPCLCRAMTA>-250000.00</DSPCLCRAMTA>")), "tb.xml");
    expect(codes(negCredit)).toEqual(["blocking:MALFORMED_NUMERIC_VALUE"]);
  });

  it("a line naming a predefined group proves a group-wise export, which XML cannot tell apart from ledgers: refused", () => {
    const text = fs.readFileSync(path.join(FIX, "tally-trial-balance-fy2025.xml"), "utf8");
    const grouped = read(enc(text.replace("<DSPDISPNAME>Share Capital</DSPDISPNAME>", "<DSPDISPNAME>Capital Account</DSPDISPNAME>")), "tb.xml");
    expect(codes(grouped)).toEqual(["blocking:UNSUPPORTED_LAYOUT"]);
    expect(find(grouped, "UNSUPPORTED_LAYOUT")?.message).toMatch(/^Row 2 names Tally's predefined group “Capital Account” with no ledgers indented beneath/);
    expect(grouped.accounts.some((a) => a.accountName === "Capital Account")).toBe(false);
  });

  it("a repeated ledger name is refused as today", () => {
    const text = fs.readFileSync(path.join(FIX, "tally-trial-balance-fy2025.xml"), "utf8");
    const dup = read(enc(text.replace("<DSPDISPNAME>Salaries</DSPDISPNAME>", "<DSPDISPNAME>Rent</DSPDISPNAME>")), "tb.xml");
    expect(codes(dup)).toContain("blocking:DUPLICATE_ACCOUNT_NAME");
    expect(find(dup, "DUPLICATE_ACCOUNT_NAME")?.rows).toEqual([24, 26]);
  });

  it("refuses, by element and line, anything that is not the documented shape", () => {
    const cases: [string, RegExp][] = [
      ["<ENVELOPE><HEADER><VERSION>1</VERSION></HEADER><BODY></BODY></ENVELOPE>", /<HEADER> on line 1 is not part of the Trial Balance export shape/],
      ["<TALLYMESSAGE><LEDGER NAME=\"Cash\"/></TALLYMESSAGE>", /top-level element is <TALLYMESSAGE>, not <ENVELOPE>/],
      ["<ENVELOPE></ENVELOPE>", /has no Trial Balance lines/],
      ["<ENVELOPE><DSPACCNAME><DSPDISPNAME>Cash</DSPDISPNAME></DSPACCNAME></ENVELOPE>", /not followed by its <DSPACCINFO>/],
      ["<ENVELOPE><DSPACCNAME><DSPDISPNAME>Cash</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-1</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT></DSPCLCRAMT><DSPOPAMT/></DSPACCINFO></ENVELOPE>", /<DSPACCINFO> on line 1 contains <DSPOPAMT>/],
      ["<ENVELOPE><DSPACCNAME><DSPDISPNAME></DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT/><DSPCLCRAMT/></DSPACCINFO></ENVELOPE>", /empty <DSPDISPNAME>/],
      ["<ENVELOPE>\n<DSPACCNAME><DSPDISPNAME>Cash & Co</DSPDISPNAME></DSPACCNAME>", /line 2 has an unknown entity or a stray/],
      ["<ENVELOPE><DSPACCNAME>", /is never closed/],
      ["not xml at all", /does not start with an XML element/],
      ["<ENVELOPE><![CDATA[x]]></ENVELOPE>", /CDATA section/],
    ];
    for (const [xml, why] of cases) {
      const r2 = read(enc(xml), "tb.xml");
      expect(codes(r2), xml).toEqual(["blocking:UNSUPPORTED_FORMAT"]);
      expect(find(r2, "UNSUPPORTED_FORMAT")?.message, xml).toMatch(why);
      expect(find(r2, "UNSUPPORTED_FORMAT")?.message, xml).toMatch(/press F5 \(Ledger-wise\), export it as XML/);
    }
  });

  it("decodes XML entities in names and keeps whitespace tidy", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- synthetic -->\n<ENVELOPE>\n<DSPACCNAME><DSPDISPNAME>  Duties &amp; Taxes &#8211; VAT </DSPDISPNAME></DSPACCNAME>\n<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>\n -10.00 \n</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA/></DSPCLCRAMT></DSPACCINFO>\n<DSPACCNAME><DSPDISPNAME>Capital</DSPDISPNAME></DSPACCNAME>\n<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA></DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>10.00</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>\n</ENVELOPE>\n';
    const t = readTallyTrialBalanceXml(xml, 100);
    expect(t.ok && t.rows).toEqual([
      { rowNumber: 3, cells: ["Particulars", "Debit", "Credit"] },
      { rowNumber: 4, cells: ["Duties & Taxes – VAT", "-10.00", null] },
      { rowNumber: 8, cells: ["Capital", null, "10.00"] },
    ]);
    const r2 = read(enc(xml), "tb.xml");
    expect(r2.blocking).toBe(false);
    expect(r2.accounts.map((a) => a.accountName)).toEqual(["Duties & Taxes – VAT", "Capital"]);
    expect(parseTallyXml("<A x='1' y=\"2\"><B/>text</A>")).toMatchObject({ ok: true, root: { name: "A", children: [{ name: "B" }], text: "text" } });
  });

  it("applies the same encoding and size rules as a CSV, and takes no layout", () => {
    const utf16 = read(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]), "tb.xml");
    expect(codes(utf16)).toEqual(["blocking:ENCODING_NOT_UTF8"]);
    expect(find(utf16, "ENCODING_NOT_UTF8")?.message).toBe("The XML is saved as UTF-16. Save it as UTF-8 text and upload it again.");
    const tables = readSourceTables(bytesOf("tally-trial-balance-fy2025.xml"), "tb.xml", xlsx);
    expect(tables.ok).toBe(false);
    expect(!tables.ok && tables.issue.message).toMatch(/takes no layout/);
    const unknown = read(enc("x"), "tb.json");
    expect(find(unknown, "UNSUPPORTED_FORMAT")?.message).toBe("Upload the trial balance as .xlsx, .xls or .csv.");
  });
});

describe("the generic path is untouched", () => {
  it("no case of the characterization corpus is detected as a Tally export", () => {
    const detected = characterizationCorpus().filter((c) => read(c.bytes, c.fileName, c.periodYear as number, c.currency as string).columns.source !== undefined).map((c) => c.name);
    expect(detected).toEqual([]);
  }, 60_000);

  it("a 'Particulars' file without Tally's title block is not detected, and is read by the generic rules exactly as before", () => {
    const body = DETAILED.split("\n").slice(4).join("\n"); // no company, title or period line
    // As written (Indian grouping): the generic grammar refuses the amounts.
    const indian = readCsv(body);
    expect(indian.columns.source).toBeUndefined();
    expect(indian.columns).toMatchObject({ account_name: "Particulars", debit: "Debit", credit: "Credit" });
    expect(codes(indian)).toEqual(["blocking:MALFORMED_NUMERIC_VALUE"]);
    // Rewritten in international grouping: every named, codeless row with amounts is an account under the generic rules,
    // so the group lines double the sums and the Grand Total (checked against ALL rows above it) no longer agrees — the
    // file is refused, not silently accepted with doubled totals.
    const intl = body.replace(/"(\d{1,2}(?:,\d{2})+,\d{3}\.\d{2})"/g, (_m, n: string) => `"${Number(n.replace(/,/g, "")).toLocaleString("en-US", { minimumFractionDigits: 2 })}"`);
    const generic = readCsv(intl);
    expect(generic.columns.source).toBeUndefined();
    expect(generic.blocking).toBe(true);
    expect(codes(generic)).toContain("blocking:TOTAL_ROW_MISMATCH");
    expect(generic.accounts).toHaveLength(25);
  });

  it("the repository's coded fixture and the QuickBooks Desktop shape are not detected", () => {
    const coded = read(new Uint8Array(fs.readFileSync(path.join(__dirname, "__fixtures__", "coded-fy2025.csv"))), "coded-fy2025.csv");
    expect(coded.columns.source).toBeUndefined();
    const qbd = read(enc(",,31 Dec 25\n,,Debit,,Credit\n,ASSETS:Cash,10,,\n,EQUITY:Capital,,,10\nTOTAL,,10,,10\n"), "qbd.csv");
    expect(qbd.columns.source).toBeUndefined();
    expect(qbd.blocking).toBe(false);
  });
});
