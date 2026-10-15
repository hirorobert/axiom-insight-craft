/**
 * Phase 1 §3.8 acceptance (CFOClose-Directive-20261015): every item, automated, on invented identities and amounts.
 * Engine results are taken through the same presentation the Prepare page uses (deriveTrialBalanceVerdict).
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { deriveTrialBalanceVerdict } from "@/lib/workspace/trialBalanceVerdict";
import { EARLIER_VERSION_LABEL } from "@/lib/workspace/resultVersion";

const TITLE = [["MFANO TRADERS LTD"], ["Trial balance for the year ended 30 June 2026"], []];
const HEADER = ["NATURAL ACCOUNT", "DESCRIPTION", "DEBIT AMOUNT", "CREDIT AMOUNT"];
const CURRENCY_ROW = [null, null, "TZS", "TZS"];
const ACCOUNTS = [["91001", "Service charges", 100.12, null], ["91002", "Rent received", 46.25, null], ["93001", "Capital", null, 146.37]];
const FOOTER = [[], ["Prepared by:"], ["Date:"], ["Printed on 15/10/2026"], ["Page 1 of 1"], ["*** End of report ***"]];

function read(rows: unknown[][], workspaceEntityName: string | null = "Mfano Traders Limited") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "TB");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xls" }));
  return readTrialBalanceSource(bytes, { fileName: "synthetic.xls", periodYear: 2026, currency: "TZS", workspaceEntityName }, XLSX as unknown as XlsxLike);
}
const printed = (accounts = ACCOUNTS, control: unknown[] = [null, null, 146.37, 146.37], entity?: string | null) =>
  read([...TITLE, HEADER, CURRENCY_ROW, ...accounts, control, ...FOOTER], entity);
const codes = (r: ReturnType<typeof read>) => r.issues.map((i) => i.code);

describe("Phase 1 acceptance", () => {
  it("1. a clean printed workbook (title block, currency row, terminal control total, footer): every row accounted for, no issues", () => {
    const r = printed();
    expect(r.issues).toEqual([]);
    const s = r.lineageSummary;
    expect(s.preamble + s.header + s.blank + s.heading + s.total + s.zero_balance + s.account + s.rejected).toBe(s.rowsRead);
    expect(s.account).toBe(3);
    expect(s.total).toBe(1);
  });
  it("2. accounts out of balance: only the imbalance finding", () => {
    const accounts = [...ACCOUNTS.slice(0, 2), ["93001", "Capital", null, 140.02]];
    expect(codes(printed(accounts, [null, null, 146.37, 140.02]))).toEqual(["TRIAL_BALANCE_IMBALANCE"]);
  });
  it("3. accounts balance, printed totals differ: only the control-mismatch finding", () => {
    const r = printed(ACCOUNTS, [null, null, 146.37, 145.37]);
    expect(codes(r)).toEqual(["TOTAL_ROW_MISMATCH"]);
    expect(r.totals?.differenceMinor).toBe(0n);
  });
  it("4. footer variants are recognised only with structural evidence; a genuine account with similar wording survives", () => {
    const accounts = [...ACCOUNTS.slice(0, 2), ["40020", "Date palm plantation", null, 10], ["40021", "Printed stationery", 10, null], ACCOUNTS[2]];
    const r = read([...TITLE, HEADER, CURRENCY_ROW, ...accounts, [null, null, 156.37, 156.37], ...FOOTER, [null, null, null, null, 1]]);
    expect(r.issues).toEqual([]);
    expect(r.accounts.map((a) => a.accountName)).toContain("Date palm plantation");
    expect(r.accounts.map((a) => a.accountName)).toContain("Printed stationery");
    expect(r.lineage.filter((l) => /^Printed report footer/.test(l.reason ?? "")).length).toBe(6);
  });
  it("5. an unlabelled numeric row between accounts is still blocking", () => {
    const accounts = [ACCOUNTS[0], [null, null, 100.12, 0], ...ACCOUNTS.slice(1)];
    const r = printed(accounts);
    expect(codes(r)).toContain("MISSING_ACCOUNT_CODE");
    expect(r.blocking).toBe(true);
  });
  it("6. a title-block entity that differs from the workspace's: the confirmation, with source text and location; nothing renamed or moved", () => {
    const r = printed(ACCOUNTS, [null, null, 146.37, 146.37], "Kilele Enterprises Limited");
    const issue = r.issues.find((i) => i.code === "ENTITY_NAME_DIFFERS");
    expect(issue?.severity).toBe("review");
    expect(issue?.message).toBe("This file names MFANO TRADERS LTD; this workspace is Kilele Enterprises Limited. Same entity? (From your file: “MFANO TRADERS LTD”, cell A1.)");
    expect(r.blocking).toBe(false);
    // Evidence only: the accounts, totals and the entity text are exactly as read; no field carries a rename.
    expect(r.totals).toEqual(printed().totals);
    expect(r.evidence.entity?.text).toBe("MFANO TRADERS LTD");
  });
  it("7. a result from before the processing milestones: labelled as an earlier version, history unchanged", () => {
    const passed = ["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"].map((id) => ({ id, label: id, state: "passed" as const, detail: "recorded" }));
    const v = deriveTrialBalanceVerdict({ upload: { id: "u1", status: "complete", processing_result: { validation_report: {} } }, readiness: { verdict: "certified", blocker: null, checks: passed }, canRetry: true });
    expect([v.status, v.statusLabel]).toEqual(["accepted", EARLIER_VERSION_LABEL]);
  });
  it("8. no check that did not run ever shows Passed", () => {
    const processing_result = { ingestion: { milestones: [
      { id: "read", status: "passed" }, { id: "columns", status: "failed" }, { id: "rows", status: "not_reached" },
      { id: "amounts", status: "not_reached" }, { id: "balance", status: "not_reached" }, { id: "classification", status: "not_reached" },
    ] } };
    const passed = ["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"].map((id) => ({ id, label: id, state: "passed" as const, detail: "recorded" }));
    const v = deriveTrialBalanceVerdict({ upload: { id: "u1", status: "complete", processing_result }, readiness: { verdict: "certified", blocker: null, checks: passed }, canRetry: true });
    expect(v.statusLabel).not.toBe("Reviewed");
    for (const id of ["l2_data_quality", "l3_arithmetic", "l4_classification"]) expect(v.checks.find((c) => c.id === id)?.state).not.toBe("passed");
  });
});
