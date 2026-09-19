import { describe, expect, it } from "vitest";
import { ingestEvidence } from "./intake";
import { correctEvidenceCell } from "./correction";
import type { EvidenceBatch, EvidenceType } from "./types";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const LEDGER = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nT1,2025-03-01,1000,Customers,12000000,,OPERATING,Receipts from customers\nT2,2025-04-01,1000,Suppliers,,7000000,OPERATING,Payments to suppliers\n";
const CTX = { periodStart: "2025-01-01", periodEnd: "2025-12-31" };
const WHY = "documented reason for the correction";

function make(evidenceType: EvidenceType, text: string, extra: { currency?: string; scale?: number } = { currency: "TZS", scale: 2 }): EvidenceBatch {
  const r = ingestEvidence({ companyId: COMPANY, evidenceType, periodRole: "CURRENT", reportingPeriodId: "FY2025", text, ...extra, ...CTX });
  if (r.outcome !== "PARSED" || r.batch.validationStatus === "INVALID") throw new Error(`fixture rejected: ${evidenceType}`);
  return r.batch;
}
const ledger = () => make("TRANSACTION_LEDGER", LEDGER);

describe("correctEvidenceCell", () => {
  it("creates a new immutable evidence version that differs in exactly the corrected cell", () => {
    const before = ledger();
    const r = correctEvidenceCell(before, { rowNumber: 2, column: "payment", newValue: "6500000", rationale: "Supplier invoice re-agreed" }, CTX);
    expect("batch" in r).toBe(true);
    if (!("batch" in r)) return;
    expect(r.previousValue).toBe("7000000");
    expect(r.supersedesBatchId).toBe(before.evidenceBatchId);
    expect(r.batch.evidenceBatchId).not.toBe(before.evidenceBatchId);
    expect(r.batch.contentHash).not.toBe(before.contentHash);
    expect(r.batch.seriesKey).toBe(before.seriesKey);
    const cells = (b: EvidenceBatch) => b.document.rows.flat();
    const changed = cells(before).map((c, i) => [c, cells(r.batch)[i]]).filter(([a, b]) => a !== b);
    expect(changed).toEqual([["7000000", "6500000"]]);
    expect(before.document.rows[1][before.document.columns.indexOf("payment")]).toBe("7000000"); // the original was not touched
  });

  it("is deterministic: the same correction of the same batch yields the same version identity", () => {
    const c = { rowNumber: 1, column: "receipt", newValue: "11000000", rationale: "Credit note issued" };
    const a = correctEvidenceCell(ledger(), c, CTX);
    const b = correctEvidenceCell(ledger(), c, CTX);
    expect("batch" in a && "batch" in b).toBe(true);
    if ("batch" in a && "batch" in b) {
      expect(a.batch.replayIdentity).toBe(b.batch.replayIdentity);
      expect(a.batch.contentHash).toBe(b.batch.contentHash);
      expect(a.batch.evidenceBatchId).toBe(b.batch.evidenceBatchId);
    }
  });

  it("re-validates through the intake contract: a value intake would refuse cannot be introduced by a correction", () => {
    expect("reason" in correctEvidenceCell(ledger(), { rowNumber: 1, column: "receipt", newValue: "12,000,000.50x", rationale: "typo while editing" }, CTX)).toBe(true);
    expect("reason" in correctEvidenceCell(ledger(), { rowNumber: 1, column: "date", newValue: "2031-01-01", rationale: "moved out of the period" }, CTX)).toBe(true);
  });

  it.each([
    ["an unknown column", { rowNumber: 1, column: "nope", newValue: "1", rationale: WHY }],
    ["row 0", { rowNumber: 0, column: "receipt", newValue: "1", rationale: WHY }],
    ["a row past the end", { rowNumber: 3, column: "receipt", newValue: "1", rationale: WHY }],
    ["a fractional row", { rowNumber: 1.5, column: "receipt", newValue: "1", rationale: WHY }],
    ["an unchanged value", { rowNumber: 1, column: "receipt", newValue: "12000000", rationale: WHY }],
    ["a missing rationale", { rowNumber: 1, column: "receipt", newValue: "11000000", rationale: "  short " }],
  ])("refuses %s", (_n, c) => {
    expect("reason" in correctEvidenceCell(ledger(), c, CTX)).toBe(true);
  });

  it("refuses trial balances and extracted candidates (they are not corrected as evidence cells)", () => {
    const b = ledger();
    for (const t of ["EXTRACTED_CANDIDATES", "TRIAL_BALANCE"] as const) expect("reason" in correctEvidenceCell({ ...b, evidenceType: t }, { rowNumber: 1, column: "receipt", newValue: "1", rationale: WHY }, CTX)).toBe(true);
  });

  it("refuses an invalid batch", () => {
    expect("reason" in correctEvidenceCell({ ...ledger(), validationStatus: "INVALID" }, { rowNumber: 1, column: "receipt", newValue: "1", rationale: WHY }, CTX)).toBe(true);
  });

  it.each([
    ["equity movement", "EQUITY_MOVEMENTS" as const, "component,movement_type,amount,description\nShare capital,OPENING_BALANCE,1000,\nShare capital,CLOSING_BALANCE,1000,\n", { rowNumber: 2, column: "amount", newValue: "1200" }],
    ["budget figure", "BUDGET" as const, "line_key,line_label,nature,original_budget,final_budget,explanation\nrev.grants,Grants,REVENUE,1000.00,1100.00,Reallocated by Council\n", { rowNumber: 1, column: "final_budget", newValue: "1150.00" }],
    ["IPSAS cash figure", "IPSAS_CASH_RECEIPTS_PAYMENTS" as const, "section,line_key,line_label,amount,category\nOPENING_CASH,open,Opening cash,50,\nRECEIPTS,tax,Tax receipts,100,\nCLOSING_CASH,close,Closing cash,150,\n", { rowNumber: 2, column: "amount", newValue: "110" }],
    ["schedule figure", "SUPPORTING_SCHEDULE" as const, "schedule_key,schedule_title,role,row_label,amount,ties_to_line_key\nppe,Property plant,OPENING,Opening,100,\nppe,Property plant,CLOSING,Closing,100,sfp.ppe\n", { rowNumber: 2, column: "amount", newValue: "120" }],
  ])("corrects a %s through the same contract", (_n, type, text, c) => {
    const r = correctEvidenceCell(make(type, text), { ...c, rationale: WHY }, CTX);
    expect("batch" in r, JSON.stringify(r)).toBe(true);
  });

  it("corrects note and disclosure text without touching money", () => {
    const b = make("NOTES_AND_POLICIES", 'kind,key,title,body\nPOLICY,pol.rev,Revenue,"Revenue is recognised as stated by management."\n', {});
    const r = correctEvidenceCell(b, { rowNumber: 1, column: "body", newValue: "Revenue is recognised when control transfers.", rationale: WHY }, CTX);
    expect("batch" in r).toBe(true);
  });
});
