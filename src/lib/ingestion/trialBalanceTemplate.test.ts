/**
 * Template safety: the two downloads are static, neutral and safe to open in a spreadsheet, and the server's own
 * ingestion core proves the example balances exactly yet is refused if uploaded unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import {
  EXAMPLE_FILE_NAME, EXAMPLE_ROWS, FILE_RULES, TEMPLATE_FILE_NAME, TEMPLATE_HEADER, exampleCsv, neutraliseCell, templateCsv, toCsv,
} from "./trialBalanceTemplate";

const ingest = (text: string) =>
  readTrialBalanceSource(new TextEncoder().encode(text), { fileName: "upload.csv", periodYear: 2025, currency: "USD" }, XLSX as unknown as XlsxLike);

describe("trial balance template downloads", () => {
  it("the template is the header row only", () => {
    expect(templateCsv()).toBe("\uFEFFAccount Code,Account Name,Debit,Credit\r\n");
    expect(TEMPLATE_HEADER).toEqual(["Account Code", "Account Name", "Debit", "Credit"]);
  });

  it("the example balances exactly under the server's ingestion core, but is refused if uploaded unchanged", () => {
    const asIs = ingest(exampleCsv());
    expect(asIs.issues.map((i) => i.code)).toEqual(["TEMPLATE_EXAMPLE_UPLOADED"]);
    expect(asIs.totals).toEqual({ debitMinor: 6150000000n, creditMinor: 6150000000n, differenceMinor: 0n });

    const edited = ingest(exampleCsv().replace(/Example — /g, ""));
    expect(edited.issues).toEqual([]);
    expect(edited.accounts).toHaveLength(EXAMPLE_ROWS.length);
  });

  it("file names and contents are fixed — no company, year or workspace data", () => {
    expect(TEMPLATE_FILE_NAME).toBe("trial-balance-template.csv");
    expect(EXAMPLE_FILE_NAME).toBe("trial-balance-example.csv");
    const guide = fs.readFileSync(path.join(__dirname, "../../components/workspace/TrialBalanceTemplateGuide.tsx"), "utf8");
    expect(guide).not.toMatch(/companyName|periodYear|slug/);
    expect(guide).toMatch(/export default function TrialBalanceTemplateGuide\(\)/);
  });

  it("neutralises cells a spreadsheet would run as formulas", () => {
    for (const evil of ["=HYPERLINK(\"x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rx"]) expect(neutraliseCell(evil).startsWith("'")).toBe(true);
    expect(neutraliseCell("Cash")).toBe("Cash");
    expect(toCsv([["=1+1", "a,b", "say \"hi\""]])).toBe("\uFEFF'=1+1,\"a,b\",\"say \"\"hi\"\"\"\r\n");
  });

  it("contains no jurisdiction-specific wording (global surface)", () => {
    const src = fs.readFileSync(path.join(__dirname, "trialBalanceTemplate.ts"), "utf8");
    // The same pattern the jurisdiction copy audit applies to every global source file (it scans this one too).
    expect(src).not.toMatch(/\b(TRA|TIN|EFDMS|TAA|ITA|SDL|NSSF|WCF|PAYE|TZS)\b|Tanzania|Finance Act|Cap\.\s?332/);
  });

  it("every stated rule is one the ingestion core enforces", () => {
    expect(ingest("Trial balance for the year ended 31 December 2024\nCode,Name,Debit,Credit\n1,A,1,\n2,B,,1\n").issues[0].code).toBe("PERIOD_MISMATCH");
    expect(ingest("Code,Name,Debit,Credit\n1,A,1.001,\n2,B,,1.001\n").issues[0].code).toBe("PRECISION_EXCEEDS_CURRENCY");
    expect(ingest("Code,Name,Debit,Credit\n1,A,1.01,\n2,B,,1\n").issues[0].code).toBe("TRIAL_BALANCE_IMBALANCE");
    expect(ingest("Code,Name,Debit,Credit\n1,A,1,\n2,B,,1\n,Total,2,1\n").issues[0].code).toBe("TOTAL_ROW_MISMATCH");
    expect(ingest("Code,Name,Debit,Credit\n1,A,1,\n9,Total assets,1,\n2,B,,1\n").accounts.map((a) => a.accountCode)).toContain("9");
    expect(ingest("Title\n\nCode,Name,Debit,Credit\n,ASSETS,,\n1,A,1,\n2,B,,1\n").issues).toEqual([]);
    expect(FILE_RULES).toHaveLength(6);
  });
});
