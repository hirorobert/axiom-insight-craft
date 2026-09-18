import { describe, expect, it } from "vitest";
import { classifyReplay, ingestEvidence, isUsableEvidence, replayIdentityOf, type IntakeRequest } from "./intake";
import { parseCsv, isFormulaLike, toCsv } from "./csv";
import { EVIDENCE_TYPES } from "./types";

const base = { companyId: "c1", periodRole: "CURRENT", reportingPeriodId: "FY2025", currency: "TZS", scale: 2 } as const;
const req = (o: Partial<IntakeRequest> & { text: string; evidenceType: IntakeRequest["evidenceType"] }): IntakeRequest => ({ ...base, ...o }) as IntakeRequest;
const parsed = (o: Parameters<typeof req>[0]) => {
  const r = ingestEvidence(req(o));
  if (r.outcome !== "PARSED") throw new Error(`rejected: ${r.diagnostics.map((d) => d.code).join()}`);
  return r.batch;
};
const codes = (o: Parameters<typeof req>[0]) => {
  const r = ingestEvidence(req(o));
  return r.outcome === "REJECTED" ? r.diagnostics.map((d) => d.code) : r.batch.diagnostics.map((d) => d.code);
};

const LEDGER = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nT1,2025-01-15,1010,Customer receipt,1500000.50,,OPERATING,Receipts from customers\nT2,2025-02-01,1010,Supplier payment,,400000,OPERATING,Payments to suppliers\n";

describe("csv reader", () => {
  it("handles BOM, CRLF, quotes, doubled quotes and embedded newlines", () => {
    const r = parseCsv('\ufeffa,b\r\n"x,1","he said ""hi"""\r\n"multi\nline",z\r\n');
    expect(r.rows).toEqual([["a", "b"], ["x,1", 'he said "hi"'], ["multi\nline", "z"]]);
    expect(r.unterminatedQuoteAtRecord).toBeNull();
  });
  it("reports an unterminated quote instead of guessing", () => {
    expect(parseCsv('a,b\n"open,1\n').unterminatedQuoteAtRecord).toBe(2);
  });
  it("detects formula triggers including full-width look-alikes but allows negative numbers", () => {
    for (const bad of ["=1+1", "+cmd", "@SUM(A1)", "-cmd|' /C calc'!A0", "\t=1", "＝1+1", "＋1"]) expect(isFormulaLike(bad), bad).toBe(true);
    for (const ok of ["-12.50", "Receipts", "a=b", "12"]) expect(isFormulaLike(ok), ok).toBe(false);
  });
  it("export neutralises formula triggers", () => {
    expect(toCsv([["=1+1", "ok"]])).toBe("'=1+1,ok\r\n");
  });
});

describe("intake — every family", () => {
  it("cash ledger: valid rows keep amounts as exact decimal strings", () => {
    const b = parsed({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER });
    expect(b.validationStatus).toBe("VALID");
    expect(b.document.rows[0][4]).toBe("1500000.50");
    expect(b.evidenceBatchId).toMatch(/^eb-[0-9a-f]{32}$/);
    expect(JSON.stringify(b.document)).not.toMatch(/:\s*\d/); // no JSON numbers in the document
  });
  it("equity movements, budget, IPSAS cash, schedules, notes, prior statements all parse", () => {
    expect(parsed({ evidenceType: "EQUITY_MOVEMENTS", text: "component,movement_type,amount,description\nShare capital,OPENING_BALANCE,1000,\nShare capital,CLOSING_BALANCE,1000,\n" }).validationStatus).toBe("VALID");
    expect(parsed({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget,final_budget,explanation\nrev.grants,Grants,REVENUE,1000.00,1100.00,Reallocated by Council\n" }).validationStatus).toBe("VALID");
    expect(parsed({ evidenceType: "IPSAS_CASH_RECEIPTS_PAYMENTS", text: "section,line_key,line_label,amount,category\nOPENING_CASH,open,Opening cash,50,\nRECEIPTS,tax,Tax receipts,100,\nCLOSING_CASH,close,Closing cash,150,\n" }).validationStatus).toBe("VALID");
    expect(parsed({ evidenceType: "SUPPORTING_SCHEDULE", text: "schedule_key,schedule_title,role,row_label,amount,ties_to_line_key\nppe,Property plant,OPENING,Opening,100,\nppe,Property plant,CLOSING,Closing,100,sfp.ppe\n" }).validationStatus).toBe("VALID");
    expect(parsed({ evidenceType: "NOTES_AND_POLICIES", currency: undefined, scale: undefined, text: 'kind,key,title,body\nPOLICY,pol.rev,Revenue,"Revenue is recognised as stated by management.\nSecond paragraph."\n' }).validationStatus).toBe("VALID");
    expect(parsed({ evidenceType: "PRIOR_PERIOD_STATEMENTS", text: "statement_type,line_key,line_label,amount,restated\nPROFIT_OR_LOSS,rev,Revenue,900,N\n" }).validationStatus).toBe("VALID");
  });
  it("extracted candidates are always REQUIRES_REVIEW and never usable evidence", () => {
    const b = parsed({ evidenceType: "EXTRACTED_CANDIDATES", currency: undefined, scale: undefined, text: "candidate_id,source_ref,field,value\nc1,p3,Revenue,1000\n" });
    expect(b.validationStatus).toBe("REQUIRES_REVIEW");
    expect(isUsableEvidence(b)).toBe(false);
  });
  it("covers exactly nine evidence families", () => {
    expect(EVIDENCE_TYPES).toHaveLength(9);
  });
});

describe("intake — exact diagnostics", () => {
  it("names row, column and value for a bad amount", () => {
    const r = ingestEvidence(req({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER.replace("1500000.50", '"1,500,000.50"') }));
    expect(r.outcome).toBe("PARSED");
    if (r.outcome !== "PARSED") return;
    const d = r.batch.diagnostics.find((x) => x.code === "AMOUNT_HAS_SEPARATOR")!;
    expect(d).toMatchObject({ row: 1, column: "receipt", severity: "ERROR" });
    expect(d.value).toBe("1,500,000.50");
    expect(r.batch.validationStatus).toBe("INVALID");
    expect(isUsableEvidence(r.batch)).toBe(false);
  });
  it("refuses precision beyond the declared scale instead of rounding", () => {
    expect(codes({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\nk,l,REVENUE,10.005\n" })).toContain("AMOUNT_PRECISION_EXCEEDS_SCALE");
  });
  it("refuses parentheses negatives, words and exponent notation", () => {
    for (const v of ["(100)", "abc", "1e5", "1.", ".5", "--1"]) expect(codes({ evidenceType: "BUDGET", text: `line_key,line_label,nature,original_budget\nk,l,REVENUE,${v}\n` }), v).toEqual(expect.arrayContaining([expect.stringMatching(/AMOUNT_/)]));
  });
  it("a blank required amount is an error, never zero", () => {
    expect(codes({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\nk,l,REVENUE,\n" })).toContain("REQUIRED_VALUE_MISSING");
  });
  it("exactly one of receipt/payment", () => {
    expect(codes({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER.replace("Supplier payment,,400000", "Supplier payment,5,400000") })).toContain("EXACTLY_ONE_OF_RECEIPT_OR_PAYMENT");
  });
  it("duplicate ids are errors; same-body different-id rows are warnings", () => {
    expect(codes({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER + "T1,2025-03-01,1010,x,1,,OPERATING,l\n" })).toContain("DUPLICATE_TRANSACTION_ID");
    expect(codes({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER + "T3,2025-01-15,1010,Customer receipt,1500000.50,,OPERATING,Receipts from customers\n" })).toContain("POSSIBLE_DUPLICATE_TRANSACTION");
  });
  it("out-of-period dates and impossible calendar dates are errors", () => {
    expect(codes({ evidenceType: "TRANSACTION_LEDGER", periodStart: "2025-03-01", periodEnd: "2025-12-31", text: LEDGER })).toContain("DATE_OUTSIDE_PERIOD");
    expect(codes({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER.replace("2025-01-15", "2025-02-30") })).toContain("DATE_NOT_ISO");
  });
  it("unknown columns warn and are dropped; missing required columns are errors", () => {
    expect(codes({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget,junk\nk,l,REVENUE,1,x\n" })).toContain("UNKNOWN_COLUMN");
    expect(codes({ evidenceType: "BUDGET", text: "line_key,line_label\nk,l\n" })).toContain("REQUIRED_COLUMN_MISSING");
  });
  it("wrong cell counts, duplicate headers, no data rows", () => {
    expect(codes({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\nk,l,REVENUE\n" })).toContain("ROW_COLUMN_COUNT");
    expect(codes({ evidenceType: "BUDGET", text: "line_key,line_key,nature,original_budget\nk,l,REVENUE,1\n" })).toContain("DUPLICATE_COLUMN");
    expect(codes({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\n" })).toContain("NO_DATA_ROWS");
  });
  it("currency and scale must be declared for amount families", () => {
    expect(codes({ evidenceType: "BUDGET", currency: undefined, text: "a\n1\n" })).toEqual(["CURRENCY_REQUIRED"]);
    expect(codes({ evidenceType: "BUDGET", scale: undefined, text: "a\n1\n" })).toEqual(["SCALE_REQUIRED"]);
    expect(codes({ evidenceType: "BUDGET", currency: "tzs", text: "a\n1\n" })).toEqual(["CURRENCY_REQUIRED"]);
  });
});

describe("intake — rejection and adversarial input", () => {
  it("rejects XLSX by name, mime type and magic bytes without reading it", () => {
    expect(codes({ evidenceType: "BUDGET", fileName: "budget.xlsx", text: "x" })).toEqual(["XLSX_NOT_SUPPORTED"]);
    expect(codes({ evidenceType: "BUDGET", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", text: "x" })).toEqual(["XLSX_NOT_SUPPORTED"]);
    expect(codes({ evidenceType: "BUDGET", text: "PK\u0003\u0004binary" })).toEqual(["XLSX_NOT_SUPPORTED"]);
  });
  it("rejects PDFs, images, binary, empty and oversized input", () => {
    expect(codes({ evidenceType: "BUDGET", fileName: "x.pdf", text: "a" })).toEqual(["UNSUPPORTED_FILE_TYPE"]);
    expect(codes({ evidenceType: "BUDGET", text: "a\u0000b" })).toEqual(["BINARY_CONTENT"]);
    expect(codes({ evidenceType: "BUDGET", text: "   \n" })).toEqual(["EMPTY_FILE"]);
    expect(codes({ evidenceType: "BUDGET", text: "a".repeat(2_000_001) })).toEqual(["FILE_TOO_LARGE"]);
  });
  it("rejects a wrong delimiter and an unterminated quote", () => {
    expect(codes({ evidenceType: "BUDGET", text: "line_key;line_label;nature;original_budget\nk;l;REVENUE;1\n" })).toEqual(["UNSUPPORTED_DELIMITER"]);
    expect(codes({ evidenceType: "BUDGET", text: 'line_key,line_label,nature,original_budget\n"k,l,REVENUE,1\n' })).toEqual(["CSV_UNTERMINATED_QUOTE"]);
  });
  it("formula injection in any text column makes the batch INVALID", () => {
    const b = parsed({ evidenceType: "BUDGET", text: 'line_key,line_label,nature,original_budget,explanation\nk,"=HYPERLINK(""http://evil"")",REVENUE,1,\n' });
    expect(b.diagnostics.map((d) => d.code)).toContain("FORMULA_INJECTION");
    expect(b.validationStatus).toBe("INVALID");
    const n = parsed({ evidenceType: "NOTES_AND_POLICIES", currency: undefined, scale: undefined, text: "kind,key,title,body\nNOTE,n1,Title,@SUM(A1)\n" });
    expect(n.validationStatus).toBe("INVALID");
  });
  it("hidden bidi/zero-width and control characters are errors; markup is a warning and stays text", () => {
    expect(parsed({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\nk,Rev\u202eenue,REVENUE,1\n" }).diagnostics.map((d) => d.code)).toContain("HIDDEN_CHARACTER");
    expect(parsed({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\nk,Rev\u0007,REVENUE,1\n" }).diagnostics.map((d) => d.code)).toContain("CONTROL_CHARACTER");
    const m = parsed({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\nk,<script>alert(1)</script>,REVENUE,1\n" });
    expect(m.diagnostics.map((d) => d.code)).toContain("MARKUP_IN_TEXT");
    expect(m.document.rows[0][1]).toBe("<script>alert(1)</script>"); // stored verbatim, rendered as text only
  });
  it("oversized text fields and key shapes are refused", () => {
    expect(codes({ evidenceType: "BUDGET", text: `line_key,line_label,nature,original_budget\nk,${"x".repeat(501)},REVENUE,1\n` })).toContain("TEXT_TOO_LONG");
    expect(codes({ evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\nbad key!,l,REVENUE,1\n" })).toContain("KEY_MALFORMED");
  });
  it("trial balances are not parsed here", () => {
    expect(codes({ evidenceType: "TRIAL_BALANCE", text: "x" })).toEqual(["USE_TRIAL_BALANCE_IMPORT"]);
  });
  it("is deterministic: identical input yields identical batches", () => {
    expect(JSON.stringify(parsed({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER }))).toBe(JSON.stringify(parsed({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER })));
  });
});

describe("replay classification", () => {
  const b1 = parsed({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER });
  const stored = (b: typeof b1, version = 1) => ({ evidenceBatchId: b.evidenceBatchId, companyId: b.companyId, evidenceType: b.evidenceType, periodRole: b.periodRole, reportingPeriodId: b.reportingPeriodId, seriesKey: b.seriesKey, replayIdentity: b.replayIdentity, version });
  it("NEW_SERIES, EXACT_REPLAY, NEW_VERSION, CONFLICTING_REPLAY", () => {
    expect(classifyReplay(b1, [])).toEqual({ kind: "NEW_SERIES" });
    expect(classifyReplay(b1, [stored(b1)])).toEqual({ kind: "EXACT_REPLAY", existingBatchId: b1.evidenceBatchId });
    const b2 = parsed({ evidenceType: "TRANSACTION_LEDGER", text: LEDGER + "T9,2025-03-01,1010,More,1,,OPERATING,x\n" });
    expect(classifyReplay(b2, [stored(b1)])).toEqual({ kind: "NEW_VERSION", expectedPreviousBatchId: b1.evidenceBatchId, version: 2 });
    expect(classifyReplay(b1, [{ ...stored(b1), documentJson: "{}" }]).kind).toBe("CONFLICTING_REPLAY");
  });
  it("replay identity matches the documented composition", () => {
    expect(b1.replayIdentity).toBe(replayIdentityOf({ companyId: "c1", reportingPeriodId: "FY2025", evidenceType: "TRANSACTION_LEDGER", periodRole: "CURRENT", seriesKey: "default", contentHash: b1.contentHash }));
  });
  it("a different company yields a different identity for the same bytes", () => {
    expect(parsed({ evidenceType: "TRANSACTION_LEDGER", companyId: "c2", text: LEDGER }).replayIdentity).not.toBe(b1.replayIdentity);
  });
});
