import { describe, expect, it } from "vitest";
import { createTrialBalanceAdapter, type ReviewedTrialBalanceAccountLine } from "@/lib/financialStatementsWorkspace/trialBalanceAdapter";
import { profileForKind } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { buildRuleContext } from "@/lib/canonicalStatement/rules/ruleEngine";
import { runCanonicalRulePackV2 } from "@/lib/canonicalStatement/rules/rulePack";
import { ZERO_TOLERANCE, formatMoney } from "@/lib/canonicalStatement/money";
import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport, type RuleEvaluationRecord } from "@/lib/canonicalStatement/types";
import { ingestEvidence, type IntakeRequest } from "@/lib/financialEvidence/intake";
import type { EvidenceBatch, EvidenceType, PeriodRole } from "@/lib/financialEvidence/types";
import { applyEvidence, evidenceOnlyReport, latestPerSeries } from "./applyEvidence";
import { percentOneDecimal } from "./budgetActual";

const SOURCE_HASH = "a".repeat(64);
const line = (o: Partial<ReviewedTrialBalanceAccountLine> & Pick<ReviewedTrialBalanceAccountLine, "accountKey" | "accountName" | "statement" | "classification" | "normalBalance" | "balance">): ReviewedTrialBalanceAccountLine => ({
  currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: false, isRetainedEarnings: false, isPayrollAccount: false, sourceUploadId: "u1", sourceHash: SOURCE_HASH, ...o,
});
const TB = [
  line({ accountKey: "1000", accountName: "Cash at Bank", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 5_000_000, isCashAccount: true }),
  line({ accountKey: "1100", accountName: "Trade Receivables", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 2_000_000 }),
  line({ accountKey: "1500", accountName: "PPE", statement: "balance_sheet", classification: "non_current_assets", normalBalance: "debit", balance: 8_000_000 }),
  line({ accountKey: "2000", accountName: "Trade Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 3_000_000 }),
  line({ accountKey: "2500", accountName: "Loan", statement: "balance_sheet", classification: "non_current_liabilities", normalBalance: "credit", balance: 4_000_000 }),
  line({ accountKey: "3000", accountName: "Share Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 6_000_000 }),
  line({ accountKey: "3100", accountName: "Retained Earnings", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 2_000_000 }),
  line({ accountKey: "4000", accountName: "Sales", statement: "income_statement", classification: "revenue", normalBalance: "credit", balance: 12_000_000 }),
  line({ accountKey: "5000", accountName: "Cost of Sales", statement: "income_statement", classification: "cost_of_goods_sold", normalBalance: "debit", balance: 6_000_000 }),
  line({ accountKey: "6000", accountName: "Opex", statement: "income_statement", classification: "operating_expenses", normalBalance: "debit", balance: 3_000_000 }),
];

async function tbReport(): Promise<CanonicalFinancialStatementReport> {
  const x = await createTrialBalanceAdapter().normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: TB });
  return validateCanonicalReport({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "report-1", companyId: "company-1", reportVersion: 1 },
    entity: { legalName: "Test Company Ltd" },
    period: { periodId: "CURRENT", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025 },
    comparativePeriods: [],
    framework: { kind: "IFRS_FOR_SMES" },
    presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
    statements: x.statements, notes: x.notes, noteReferences: [], accountingPolicies: x.accountingPolicies, textualDisclosures: x.textualDisclosures, facts: x.facts, provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  });
}

const parse = (evidenceType: EvidenceType, text: string, periodRole: PeriodRole = "CURRENT", extra: Partial<IntakeRequest> = {}): EvidenceBatch => {
  const r = ingestEvidence({ companyId: "company-1", evidenceType, periodRole, reportingPeriodId: "FY2025", currency: "TZS", scale: 2, text, ...extra });
  if (r.outcome !== "PARSED") throw new Error(`rejected ${r.diagnostics.map((d) => d.code)}`);
  return r.batch;
};

const LEDGER = [
  "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line",
  "T1,2025-03-01,1000,Customers,12000000,,OPERATING,Receipts from customers",
  "T2,2025-04-01,1000,Suppliers,,9000000,OPERATING,Payments to suppliers",
  "T3,2025-05-01,1000,Equipment,,1000000,INVESTING,Purchase of equipment",
  "T4,2025-06-01,1000,Loan draw,1000000,,FINANCING,Proceeds from borrowings",
].join("\n") + "\n";
const OPENING_CASH = "statement_type,line_key,line_label,amount\nFINANCIAL_POSITION,cash_and_cash_equivalents_sfp,Cash,2000000\n";
const EQUITY = [
  "component,movement_type,amount,description",
  "Share capital,OPENING_BALANCE,6000000,",
  "Share capital,CLOSING_BALANCE,6000000,",
  "Retained earnings,OPENING_BALANCE,-1000000,",
  "Retained earnings,PROFIT_OR_LOSS,3000000,",
  "Retained earnings,CLOSING_BALANCE,2000000,",
].join("\n") + "\n";

const evaluate = (report: CanonicalFinancialStatementReport | null): readonly RuleEvaluationRecord[] => runCanonicalRulePackV2(buildRuleContext(report!, ZERO_TOLERANCE), () => "2026-01-01T00:00:00.000Z");
const outcomes = (records: readonly RuleEvaluationRecord[], ruleId: string) => records.filter((r) => r.ruleId === ruleId && r.outcome !== "NOT_APPLICABLE").map((r) => r.outcome);

describe("direct cash flow + equity: a consistent evidence set", () => {
  it("generates both statements, ties them to the trial-balance statements, and raises no failure", async () => {
    const base = await tbReport();
    const r = applyEvidence({ report: base, profile: profileForKind("IFRS_FOR_SMES"), cashAccountKeys: ["1000"], evidence: [parse("TRANSACTION_LEDGER", LEDGER), parse("PRIOR_PERIOD_STATEMENTS", OPENING_CASH, "COMPARATIVE", { reportingPeriodId: "FY2024" }), parse("EQUITY_MOVEMENTS", EQUITY)] });
    expect(r.generated.map((g) => [g.kind, g.result.status])).toEqual([["STATEMENT_OF_CASH_FLOWS", "GENERATED"], ["STATEMENT_OF_CHANGES_IN_EQUITY", "GENERATED"]]);
    const findings = evaluate(r.report);
    expect(findings.filter((f) => f.outcome === "FAIL").map((f) => `${f.ruleId}: ${f.deterministicCalculation} @ ${f.affected.lineId ?? f.affected.statementId ?? f.affected.noteId}`)).toEqual([]);
    expect(outcomes(findings, "cashflow-closing-cash-reconciliation")).toEqual(["PASS"]);
    expect(outcomes(findings, "equity-closing-tie")).toEqual(["PASS"]);
    expect(outcomes(findings, "equity-profit-tie")).toEqual(["PASS"]);
    const cf = r.report!.statements.find((s) => s.type === "STATEMENT_OF_CASH_FLOWS")!;
    const closing = cf.sections.flatMap((s) => s.lines).find((l) => l.role === "TOTAL" && l.concept === "cash_and_cash_equivalents_closing_cf")!;
    const fact = r.report!.facts.find((f) => f.factId === closing.factBindings[0].factId)!;
    expect(formatMoney(fact.value!)).toContain("5000000.00");
  });

  it("uses only exact integer arithmetic: a 30-digit amount survives", async () => {
    const big = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nT1,2025-03-01,1000,x,123456789012345678901234.56,,OPERATING,Big\n";
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("TRANSACTION_LEDGER", big)] });
    const f = r.report!.facts.find((x) => x.factId.startsWith("fact:line:cf:operating:"))!;
    expect(f.value!.minorUnits).toBe(12345678901234567890123456n);
  });

  it("is deterministic and order-independent", async () => {
    const base = await tbReport();
    const shuffled = LEDGER.trim().split("\n");
    const rows = [shuffled[0], ...shuffled.slice(1).reverse()].join("\n") + "\n";
    const a = applyEvidence({ report: base, profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("TRANSACTION_LEDGER", LEDGER)] });
    const b = applyEvidence({ report: base, profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("TRANSACTION_LEDGER", rows)] });
    const strip = (x: typeof a) => canonicalStringify(x.report.statements.find((s) => s.type === "STATEMENT_OF_CASH_FLOWS")!.sections.map((s) => s.lines.map((l) => [l.lineId, l.label])));
    expect(strip(a)).toBe(strip(b));
    expect(canonicalStringify(applyEvidence({ report: base, profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("TRANSACTION_LEDGER", LEDGER)] }).report)).toBe(canonicalStringify(a.report));
  });
});

describe("no plugs: defects surface as canonical findings", () => {
  it("a cash-flow closing that disagrees with the statement of financial position FAILs and is not adjusted", async () => {
    const off = LEDGER.replace("12000000", "12000001");
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), cashAccountKeys: ["1000"], evidence: [parse("TRANSACTION_LEDGER", off), parse("PRIOR_PERIOD_STATEMENTS", OPENING_CASH, "COMPARATIVE", { reportingPeriodId: "FY2024" })] });
    const f = evaluate(r.report).find((x) => x.ruleId === "cashflow-closing-cash-reconciliation" && x.outcome === "FAIL")!;
    expect(f.failureSeverity).toBe("CRITICAL");
    expect(f.deterministicCalculation).toContain("5000001.00");
  });

  it("missing opening cash yields a partial cash flow with no opening or closing line — never zero", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("TRANSACTION_LEDGER", LEDGER)] });
    const cf = r.report!.statements.find((s) => s.type === "STATEMENT_OF_CASH_FLOWS")!;
    const ids = cf.sections.flatMap((s) => s.lines.map((l) => l.lineId));
    expect(ids).not.toContain("line:cf:opening");
    expect(ids).not.toContain("line:cf:closing");
    expect(r.diagnostics.map((d) => d.code)).toContain("OPENING_CASH_MISSING");
  });

  it("equity: a stated closing that does not cast FAILs; a closing total that differs from the SFP FAILs; a profit that differs from P&L FAILs", async () => {
    const bad = EQUITY.replace("Retained earnings,CLOSING_BALANCE,2000000", "Retained earnings,CLOSING_BALANCE,2500000").replace("PROFIT_OR_LOSS,3000000", "PROFIT_OR_LOSS,3000001");
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("EQUITY_MOVEMENTS", bad)] });
    const f = evaluate(r.report);
    expect(outcomes(f, "equity-closing-tie")).toEqual(["FAIL"]);
    expect(outcomes(f, "equity-profit-tie")).toEqual(["FAIL"]);
    expect(f.filter((x) => x.ruleId === "subtotal-casting" && x.outcome === "FAIL").length).toBeGreaterThan(0);
  });

  it("equity with no opening balance is an evidence gap, not an inferred opening", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("EQUITY_MOVEMENTS", "component,movement_type,amount\nShare capital,PROFIT_OR_LOSS,10\n")] });
    const g = r.generated[0].result;
    expect(g.status).toBe("EVIDENCE_GAP");
    expect(r.report!.statements.some((s) => s.type === "STATEMENT_OF_CHANGES_IN_EQUITY")).toBe(false);
  });

  it("equity without a profit movement cannot be tied to the statement of profit or loss", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("EQUITY_MOVEMENTS", "component,movement_type,amount\nShare capital,OPENING_BALANCE,8000000\nShare capital,CLOSING_BALANCE,8000000\n")] });
    expect(outcomes(evaluate(r.report), "equity-profit-tie")).toEqual(["INSUFFICIENT_EVIDENCE"]);
  });
});

describe("supporting schedules, notes and policies", () => {
  const SCHEDULE = "schedule_key,schedule_title,role,row_label,amount,ties_to_line_key\nppe,Property plant and equipment,OPENING,Opening,7000000,\nppe,Property plant and equipment,ADDITION,Additions,1500000,\nppe,Property plant and equipment,DISPOSAL,Disposals,500000,\nppe,Property plant and equipment,CLOSING,Closing,8000000,line:detail:sfp:1500\n";
  it("a movement schedule that casts and agrees to the face passes note-to-face and movement reconciliation", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("SUPPORTING_SCHEDULE", SCHEDULE)] });
    const f = evaluate(r.report);
    expect(outcomes(f, "note-to-face-reconciliation")).toEqual(["PASS"]);
    expect(outcomes(f, "movement-reconciliation")).toEqual(["PASS"]);
    expect(f.filter((x) => x.outcome === "FAIL")).toEqual([]);
  });
  it("schedule discrepancies become canonical findings: movement, face tie and casting", async () => {
    const badMove = SCHEDULE.replace("1500000", "1500001");
    const r1 = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("SUPPORTING_SCHEDULE", badMove)] });
    expect(outcomes(evaluate(r1.report), "movement-reconciliation")).toEqual(["FAIL"]);
    const badFace = SCHEDULE.replace("8000000", "8000100").replace("1500000", "1500100");
    const r2 = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("SUPPORTING_SCHEDULE", badFace)] });
    expect(outcomes(evaluate(r2.report), "note-to-face-reconciliation")).toEqual(["FAIL"]);
    const breakdown = "schedule_key,schedule_title,role,row_label,amount,ties_to_line_key\nrec,Receivables,DETAIL,Trade,1500000,\nrec,Receivables,DETAIL,Other,400000,\nrec,Receivables,TOTAL,Total,2000000,line:detail:sfp:1100\n";
    const r3 = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("SUPPORTING_SCHEDULE", breakdown)] });
    const f3 = evaluate(r3.report);
    expect(outcomes(f3, "schedule-casting")).toEqual(["FAIL"]);
    expect(outcomes(f3, "note-to-face-reconciliation")).toEqual(["PASS"]);
  });
  it("a schedule that names no face line is reported as untied, not silently accepted", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("SUPPORTING_SCHEDULE", SCHEDULE.replace(",line:detail:sfp:1500", ","))] });
    expect(r.diagnostics.map((d) => d.code)).toContain("SCHEDULE_NOT_TIED_TO_FACE");
  });
  it("policy and note text is verbatim with evidence-row provenance, and the checklist is never guessed", async () => {
    const notes = 'kind,key,title,body,applies_to_line_keys,checklist_ref,applicability\nPOLICY,pol1,Basis,"As written by the preparer, exactly.",,basis-of-preparation,\nNOTE,n1,Receivables,Trade receivables are shown net.,line:detail:sfp:1100,,\nPOLICY,pol2,Other,No other policies apply because none exist.,,accounting-policies,NOT_APPLICABLE\n';
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("NOTES_AND_POLICIES", notes, "CURRENT", { currency: undefined, scale: undefined })] });
    expect(r.report!.accountingPolicies.map((p) => p.text)).toEqual(["As written by the preparer, exactly."]);
    expect(r.report!.accountingPolicies[0].provenance.locator).toMatchObject({ kind: "EVIDENCE_ROW", rowNumber: 1 });
    expect(r.report!.notes.map((n) => [n.title, n.noteNumber])).toEqual([["Receivables", "1"]]);
    expect(r.checklist.map((c) => [c.areaId, c.state])).toEqual([["basis-of-preparation", "PROVIDED"], ["accounting-policies", "NOT_APPLICABLE_WITH_RATIONALE"], ["supporting-notes", "MISSING"]]);
    expect(r.checklist[1].rationale).toBe("No other policies apply because none exist.");
  });
  it("no evidence means no invented policy, note or disclosure", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [] });
    expect([r.report!.notes.length, r.report!.accountingPolicies.length, r.report!.textualDisclosures.length]).toEqual([0, 0, 0]);
    expect(r.checklist.every((c) => c.state === "MISSING")).toBe(true);
  });
});

describe("budget versus actual", () => {
  const BUDGET = "line_key,line_label,nature,original_budget,final_budget,explanation\nline:result:pl:net_result,Net result,OTHER,2000000,,\nline:detail:pl:4000,Sales,REVENUE,10000000,11000000,Council approved a reallocation\nline:detail:pl:6000,Opex,EXPENSE,2500000,,\nnot.a.line,Ghost,EXPENSE,100,,\nline:detail:pl:5000,Cost,EXPENSE,0,,\n";
  it("computes exact variances, half-up percentages, direction and never invents an actual or an explanation", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("BUDGET", BUDGET)] });
    if (r.budgetActual?.status !== "GENERATED") throw new Error("not generated");
    const by = Object.fromEntries(r.budgetActual.lines.map((l) => [l.lineKey, l]));
    expect(by["line:detail:pl:4000"]).toMatchObject({ comparisonBasis: "FINAL_BUDGET", variancePercent: "9.1", direction: "FAVOURABLE", preparerExplanation: "Council approved a reallocation" });
    expect(formatMoney(by["line:detail:pl:4000"].variance!)).toContain("1000000.00");
    expect(by["line:detail:pl:6000"]).toMatchObject({ direction: "ADVERSE", variancePercent: "20.0", preparerExplanation: null, explanationRequired: null });
    expect(by["line:result:pl:net_result"]).toMatchObject({ direction: "NOT_JUDGED" });
    expect(by["not.a.line"]).toMatchObject({ actual: null, variance: null, direction: "NOT_JUDGED" });
    expect(by["not.a.line"].notes[0]).toContain("no actual is assumed");
    expect(by["line:detail:pl:5000"]).toMatchObject({ variancePercent: null });
    expect(r.budgetActual.diagnostics.map((d) => d.code)).toContain("MATERIALITY_THRESHOLD_NOT_SET");
  });
  it("flags a missing explanation only against a preparer-supplied materiality, and generates none", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("BUDGET", BUDGET)], budget: { materialityPercent: "10" } });
    if (r.budgetActual?.status !== "GENERATED") throw new Error("not generated");
    expect(r.budgetActual.lines.find((l) => l.lineKey === "line:detail:pl:6000")).toMatchObject({ explanationRequired: true, preparerExplanation: null });
    expect(r.budgetActual.diagnostics.map((d) => d.code)).toContain("EXPLANATION_REQUIRED_MISSING");
  });
  it("percentages round half-up away from zero and never pass through a float", () => {
    expect(percentOneDecimal(1n, 3n)).toBe("33.3");
    expect(percentOneDecimal(1n, 8n)).toBe("12.5");
    expect(percentOneDecimal(-1n, 8n)).toBe("-12.5");
    expect(percentOneDecimal(1n, 16n)).toBe("6.3"); // 6.25 → 6.3 half-up
    expect(percentOneDecimal(5n, 0n)).toBeNull();
    expect(percentOneDecimal(0n, 7n)).toBe("0.0");
  });
  it("a budget in a different currency or scale is an evidence gap, not converted", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("BUDGET", BUDGET.replace(/\d+,,/g, "1,,"), "CURRENT", { currency: "USD" })] });
    expect(r.budgetActual?.status).toBe("EVIDENCE_GAP");
  });
});

describe("IPSAS cash-basis receipts and payments", () => {
  const CASHBASIS = "section,line_key,line_label,amount,category\nOPENING_CASH,open,Opening cash,500,\nRECEIPTS,tax,Tax receipts,1000,\nRECEIPTS,grant,Grants,200,\nPAYMENTS,sal,Salaries,700,\nPAYMENTS,sup,Suppliers,150,\nTHIRD_PARTY_PAYMENTS,tp,Paid by donor,80,\nCLOSING_CASH,close,Closing cash,850,\n";
  const shell = () => evidenceOnlyReport({ reportId: "ipsas-1", companyId: "company-1", entityName: "Council", periodYear: 2025, startDate: "2025-07-01", endDate: "2026-06-30", framework: { kind: "IPSAS_CASH" }, currency: "TZS", scale: 2 });
  it("generates the statement; third-party payments are memorandum only; closing casts", () => {
    const r = applyEvidence({ report: shell(), profile: profileForKind("IPSAS_CASH"), evidence: [parse("IPSAS_CASH_RECEIPTS_PAYMENTS", CASHBASIS)] });
    expect(r.generated[0]).toMatchObject({ kind: "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS" });
    const f = evaluate(r.report);
    expect(f.filter((x) => x.outcome === "FAIL")).toEqual([]);
    const st = r.report!.statements[0];
    const net = st.sections.flatMap((s) => s.lines).find((l) => l.lineId === "line:ipsas:net-movement")!;
    expect(net.castingChildLineIds).toEqual(["line:ipsas:receipts:total", "line:ipsas:payments:total"]);
    expect(outcomes(f, "subtotal-casting").every((o) => o === "PASS")).toBe(true);
  });
  it("a stated closing that disagrees with opening + net FAILs casting; nothing is plugged", () => {
    const r = applyEvidence({ report: shell(), profile: profileForKind("IPSAS_CASH"), evidence: [parse("IPSAS_CASH_RECEIPTS_PAYMENTS", CASHBASIS.replace(",850,", ",851,"))] });
    expect(evaluate(r.report).filter((x) => x.ruleId === "subtotal-casting" && x.outcome === "FAIL").length).toBe(1);
  });
  it("no opening cash → evidence gap, no statement", () => {
    const r = applyEvidence({ report: shell(), profile: profileForKind("IPSAS_CASH"), evidence: [parse("IPSAS_CASH_RECEIPTS_PAYMENTS", CASHBASIS.replace("OPENING_CASH,open,Opening cash,500,\n", ""))] });
    expect(r.generated[0].result.status).toBe("EVIDENCE_GAP");
    expect(r.report).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toContain("REPORT_NOT_FORMABLE");
  });
});

describe("evidence gating", () => {
  it("INVALID and candidate evidence never feeds a statement, and the exclusion is recorded", async () => {
    const bad = parse("TRANSACTION_LEDGER", LEDGER.replace("12000000", "12,000,000").replace(/"/g, ""), "CURRENT");
    void bad;
    const invalid = parse("BUDGET", "line_key,line_label,nature,original_budget\nk,l,REVENUE,abc\n");
    const cand = parse("EXTRACTED_CANDIDATES", "candidate_id,source_ref,field,value\nc1,p1,Revenue,999\n", "CURRENT", { currency: undefined, scale: undefined });
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [invalid, cand] });
    expect(r.budgetActual).toBeNull();
    expect(r.use.filter((u) => !u.used).map((u) => u.evidenceType).sort()).toEqual(["BUDGET", "EXTRACTED_CANDIDATES"]);
    expect(r.report!.facts.length).toBe((await tbReport()).facts.length);
  });
  it("only the latest version of a series is used", async () => {
    const v1 = parse("TRANSACTION_LEDGER", LEDGER);
    const v2 = parse("TRANSACTION_LEDGER", LEDGER.replace("12000000", "13000000"));
    const latest = latestPerSeries([{ batch: v1, version: 1 }, { batch: v2, version: 2 }]);
    expect(latest.map((b) => b.evidenceBatchId)).toEqual([v2.evidenceBatchId]);
  });
  it("a comparative batch with no declared comparative period is not used", async () => {
    const r = applyEvidence({ report: await tbReport(), profile: profileForKind("IFRS_FOR_SMES"), evidence: [parse("TRANSACTION_LEDGER", LEDGER, "COMPARATIVE", { reportingPeriodId: "FY2024" })] });
    expect(r.use[0]).toMatchObject({ used: false });
    expect(r.use[0].reason).toContain("no comparative");
  });
});
