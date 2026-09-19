import { describe, expect, it } from "vitest";
import { createTrialBalanceAdapter, type ReviewedTrialBalanceAccountLine } from "@/lib/financialStatementsWorkspace/trialBalanceAdapter";
import { profileForKind } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { buildRuleContext } from "@/lib/canonicalStatement/rules/ruleEngine";
import { runCanonicalRulePackV2 } from "@/lib/canonicalStatement/rules/rulePack";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport, type RuleEvaluationRecord } from "@/lib/canonicalStatement/types";
import { ingestEvidence, type IntakeRequest } from "@/lib/financialEvidence/intake";
import type { EvidenceBatch, EvidenceType, PeriodRole } from "@/lib/financialEvidence/types";
import { applyEvidence } from "./applyEvidence";
import { cashPerimeterFactId } from "./cashPerimeter";

const HASH = "a".repeat(64);
type Acc = { key: string; name: string; cls: "current_assets" | "current_liabilities" | "equity"; normal: "debit" | "credit"; cur: number; prior?: number; cash?: boolean };
const ACCOUNTS: Acc[] = [
  { key: "1010", name: "Bank A", cls: "current_assets", normal: "debit", cur: 3_000_000, prior: 2_000_000, cash: true },
  { key: "1020", name: "Bank B", cls: "current_assets", normal: "debit", cur: 1_500_000, prior: 1_000_000, cash: true },
  { key: "1030", name: "Cash on hand", cls: "current_assets", normal: "debit", cur: 200_000, prior: 100_000, cash: true },
  { key: "1040", name: "Mobile money", cls: "current_assets", normal: "debit", cur: 300_000, prior: 200_000, cash: true },
  { key: "1050", name: "Project account", cls: "current_assets", normal: "debit", cur: 500_000, prior: 300_000, cash: true },
  { key: "1060", name: "Restricted deposit", cls: "current_assets", normal: "debit", cur: 100_000, prior: 100_000, cash: true },
  { key: "1090", name: "ECL allowance on cash", cls: "current_assets", normal: "debit", cur: -50_000, prior: -30_000, cash: true },
  { key: "1099", name: "Fixed deposit 6 months", cls: "current_assets", normal: "debit", cur: 250_000, prior: 250_000 },
  { key: "2050", name: "Bank overdraft", cls: "current_liabilities", normal: "credit", cur: 400_000, prior: 150_000 },
  { key: "3000", name: "Share capital", cls: "equity", normal: "credit", cur: 5_400_000, prior: 3_770_000 },
];

const lines = (accounts: Acc[]): ReviewedTrialBalanceAccountLine[] =>
  accounts.flatMap((a) =>
    ([["CURRENT", a.cur, false], ["PRIOR_2024", a.prior, true]] as const)
      .filter(([, v]) => v !== undefined)
      .map(([periodId, v, isComparative]) => ({ accountKey: a.key, accountName: a.name, statement: "balance_sheet" as const, classification: a.cls, normalBalance: a.normal, balance: v as number, currency: "TZS", scale: 2, periodId, isComparative, isCashAccount: a.cash ?? false, isRetainedEarnings: false, isPayrollAccount: false, sourceUploadId: "u1", sourceHash: HASH })),
  );

async function tbReport(accounts: Acc[] = ACCOUNTS): Promise<CanonicalFinancialStatementReport> {
  const x = await createTrialBalanceAdapter().normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines(accounts) });
  return validateCanonicalReport({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "report-cash", companyId: "company-1", reportVersion: 1 },
    entity: { legalName: "Multi Cash Ltd" },
    period: { periodId: "CURRENT", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025 },
    comparativePeriods: [{ periodId: "PRIOR_2024", startDate: "2024-01-01", endDate: "2024-12-31", periodYear: 2024, isRestated: false }],
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

const MAP_HEADER = "account_key,category,effect,include_in_cash_flow,note\n";
const MAP_ROWS = [
  "1010,BANK_ACCOUNT,ADD,Y,",
  "1020,BANK_ACCOUNT,ADD,Y,",
  "1030,CASH_ON_HAND,ADD,Y,",
  "1040,MOBILE_MONEY,ADD,Y,",
  "1050,DESIGNATED_PROJECT,ADD,Y,donor project",
  "1060,RESTRICTED_CASH,ADD,Y,",
  "1090,CASH_ECL_ALLOWANCE,ADD,N,allowance is a negative asset balance",
  "1099,EXCLUDED_NON_CASH,ADD,N,6-month deposit is not cash equivalent",
  "2050,OVERDRAFT,SUBTRACT,Y,repayable on demand and integral to cash management",
];
const mapCsv = (rows: string[] = MAP_ROWS) => MAP_HEADER + rows.join("\n") + "\n";
const ledger = (receipt: string) => `transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nT1,2025-03-01,1010,Customers,${receipt},,OPERATING,Receipts from customers\n`;

const evaluate = (report: CanonicalFinancialStatementReport | null): readonly RuleEvaluationRecord[] => runCanonicalRulePackV2(buildRuleContext(report!, ZERO_TOLERANCE), () => "2026-01-01T00:00:00.000Z");
const rule6 = (f: readonly RuleEvaluationRecord[]) => f.filter((x) => x.ruleId === "cashflow-closing-cash-reconciliation" && x.outcome !== "NOT_APPLICABLE");
const run = async (over: { map?: string; ledgerReceipt?: string; accounts?: Acc[]; cashKeys?: string[]; withPrior?: boolean } = {}) => {
  const base = await tbReport(over.accounts);
  const evidence = [parse("CASH_ACCOUNT_MAP", over.map ?? mapCsv(), "CURRENT", { currency: undefined, scale: undefined }), parse("TRANSACTION_LEDGER", ledger(over.ledgerReceipt ?? "1650000"))];
  return applyEvidence({ report: base, profile: profileForKind("IFRS_FOR_SMES"), cashAccountKeys: over.cashKeys ?? ACCOUNTS.filter((a) => a.cash).map((a) => a.key), evidence });
};
const factOf = (r: { report: CanonicalFinancialStatementReport | null }, role: Parameters<typeof cashPerimeterFactId>[0], period = "CURRENT") => r.report!.facts.find((f) => f.factId === cashPerimeterFactId(role, period))?.value?.minorUnits;

describe("multi-account cash perimeter", () => {
  it("aggregates several banks, cash on hand, mobile money, designated and restricted cash, ECL and an overdraft — and the ledger ties", async () => {
    const r = await run();
    expect(r.cashPerimeter?.status).toBe("ESTABLISHED");
    // gross 5,600,000.00 ; restricted+designated 600,000.00 ; ECL −50,000.00 ; overdraft in cash −400,000.00 ; excluded 250,000.00 ; net 5,550,000.00 ; cf expected 5,200,000.00
    expect(factOf(r, "gross")).toBe(560_000_000n);
    expect(factOf(r, "restricted")).toBe(60_000_000n);
    expect(factOf(r, "ecl")).toBe(-5_000_000n);
    expect(factOf(r, "overdraft")).toBe(-40_000_000n);
    expect(factOf(r, "excluded")).toBe(25_000_000n);
    expect(factOf(r, "net")).toBe(555_000_000n);
    expect(factOf(r, "cfexpected")).toBe(520_000_000n);
    const f = rule6(evaluate(r.report));
    expect(f.map((x) => [x.outcome, x.periodId ?? "CURRENT"])).toEqual([["PASS", "CURRENT"]]);
    expect(f[0].deterministicCalculation).toContain("closing cash 5200000.00 − ECL allowance 50000.00 + overdrafts included in cash 400000.00 = net cash on the statement of financial position 5550000.00");
    expect(f[0].deterministicCalculation).toContain("600000.00 is restricted or designated");
  });

  it("the known ECL pattern: cash-flow closing cash − cash ECL allowance = net SFP cash (no overdraft in cash)", async () => {
    const noOverdraft = MAP_ROWS.map((row) => (row.startsWith("2050") ? "2050,OVERDRAFT,SUBTRACT,N,presented as a liability" : row));
    const r = await run({ map: mapCsv(noOverdraft), ledgerReceipt: "1900000" });
    const f = rule6(evaluate(r.report));
    expect(f[0].outcome).toBe("PASS");
    expect(f[0].deterministicCalculation).toContain("closing cash 5600000.00 − ECL allowance 50000.00 + overdrafts included in cash 0.00 = net cash on the statement of financial position 5550000.00");
    expect(factOf(r, "net")! ).toBe(factOf(r, "cfexpected")! + factOf(r, "ecl")!);
  });

  it("a ledger that disagrees with the trial-balance cash FAILs with every component and nothing is adjusted", async () => {
    const r = await run({ ledgerReceipt: "1650001" });
    const f = rule6(evaluate(r.report))[0];
    expect(f.outcome).toBe("FAIL");
    expect(f.failureSeverity).toBe("CRITICAL");
    expect(f.deterministicCalculation).toContain("5200001.00 vs perimeter 5200000.00");
    expect(factOf(r, "cfexpected")).toBe(520_000_000n); // the perimeter is not moved toward the ledger
    expect(r.report!.facts.filter((x) => x.supersedesVersion !== null)).toHaveLength(0);
  });

  it("opening cash aggregates the comparative perimeter across ALL eligible accounts", async () => {
    const r = await run();
    // comparative: 2,000,000+1,000,000+100,000+200,000+300,000+100,000 = 3,700,000 ; overdraft in cash −150,000 → 3,550,000
    expect(factOf(r, "cfexpected", "PRIOR_2024")).toBe(355_000_000n);
    const cf = r.report!.statements.find((s) => s.type === "STATEMENT_OF_CASH_FLOWS")!;
    const opening = cf.sections.flatMap((s) => s.lines).find((l) => l.lineId === "line:cf:opening")!;
    const fact = r.report!.facts.find((x) => x.factId === opening.factBindings[0].factId)!;
    expect(fact.value!.minorUnits).toBe(355_000_000n);
    expect(fact.provenance.originalText).toContain("comparative-period cash perimeter");
  });

  it("an overdraft NOT flagged for cash is excluded from the closing figure but still explained", async () => {
    const rows = MAP_ROWS.map((row) => (row.startsWith("2050") ? "2050,OVERDRAFT,SUBTRACT,N,shown as a liability" : row));
    const r = await run({ map: mapCsv(rows), ledgerReceipt: "1900000" });
    expect(factOf(r, "overdraft")).toBe(0n);
    expect(rule6(evaluate(r.report))[0].outcome).toBe("PASS");
  });

  it("AMBIGUITY: a reviewed cash account with no category yields insufficient evidence and NO perimeter figure", async () => {
    const r = await run({ map: mapCsv(MAP_ROWS.filter((row) => !row.startsWith("1040"))) });
    expect(r.cashPerimeter?.status).toBe("UNRESOLVED");
    expect(r.cashPerimeter?.reasons.join(" ")).toContain("1040");
    expect(r.diagnostics.map((d) => d.code)).toContain("CASH_ACCOUNT_UNMAPPED");
    expect(factOf(r, "gross")).toBeUndefined();
    const f = rule6(evaluate(r.report));
    expect(f.map((x) => x.outcome)).toEqual(["INSUFFICIENT_EVIDENCE"]);
    expect(r.cashPerimeter?.reasons.length).toBeGreaterThan(0); // the reason is disclosed; no closing figure exists to compare
  });

  it("a mapped account that is not in the trial balance is refused, not skipped", async () => {
    const r = await run({ map: mapCsv([...MAP_ROWS, "9999,BANK_ACCOUNT,ADD,Y,"]) });
    expect(r.cashPerimeter?.status).toBe("UNRESOLVED");
    expect(r.diagnostics.map((d) => d.code)).toContain("CASH_ACCOUNT_NOT_IN_TRIAL_BALANCE");
    expect(rule6(evaluate(r.report))[0].outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("no first-match selection: an account mapped twice makes the map INVALID and unusable", () => {
    const b = parse("CASH_ACCOUNT_MAP", mapCsv([...MAP_ROWS, "1010,CASH_ON_HAND,ADD,Y,"]), "CURRENT", { currency: undefined, scale: undefined });
    expect(b.validationStatus).toBe("INVALID");
    expect(b.diagnostics.map((d) => d.code)).toContain("ACCOUNT_MAPPED_TWICE");
  });

  it("an inconsistent category/treatment pair is an error (ECL in cash flow, restricted cash outside it, unknown category, blank effect)", () => {
    const bad = (row: string) => parse("CASH_ACCOUNT_MAP", mapCsv([row]), "CURRENT", { currency: undefined, scale: undefined });
    expect(bad("1090,CASH_ECL_ALLOWANCE,ADD,Y,").diagnostics.map((d) => d.code)).toContain("CASH_MAP_INCONSISTENT");
    expect(bad("1060,RESTRICTED_CASH,ADD,N,").diagnostics.map((d) => d.code)).toContain("CASH_MAP_INCONSISTENT");
    expect(bad("1010,PETTY,ADD,Y,").diagnostics.map((d) => d.code)).toContain("VALUE_NOT_ALLOWED");
    expect(bad("1010,BANK_ACCOUNT,,Y,").diagnostics.map((d) => d.code)).toContain("REQUIRED_VALUE_MISSING");
  });

  it("without a map, several reviewed cash accounts are reported as needing one — never resolved by picking a line", async () => {
    const base = await tbReport();
    const r = applyEvidence({ report: base, profile: profileForKind("IFRS_FOR_SMES"), cashAccountKeys: ["1010", "1020"], evidence: [parse("TRANSACTION_LEDGER", ledger("100"))] });
    expect(r.diagnostics.map((d) => d.code)).toContain("CASH_ACCOUNT_MAP_REQUIRED");
    expect(r.cashPerimeter).toBeNull();
    expect(rule6(evaluate(r.report))[0].outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("is deterministic and independent of map row order", async () => {
    const a = await run();
    const b = await run({ map: mapCsv([...MAP_ROWS].reverse()) });
    const values = (x: typeof a) => ["gross", "restricted", "ecl", "overdraft", "excluded", "net", "cfexpected"].map((role) => factOf(x, role as never));
    expect(values(b)).toEqual(values(a));
  });

  it("the cash perimeter note is numbered and not reported as unreferenced", async () => {
    const r = await run();
    const n = r.report!.notes.find((x) => x.noteId === "note:cash-perimeter")!;
    expect(n.title).toBe("Cash and cash equivalents");
    expect(n.noteNumber).not.toBe("0");
    expect(r.diagnostics.some((d) => d.code === "NOTE_NOT_REFERENCED" && d.message.includes("Cash and cash equivalents"))).toBe(false);
    expect(evaluate(r.report).filter((x) => x.outcome === "FAIL" && x.ruleId !== "missing-comparative-detection").map((x) => `${x.ruleId}: ${x.deterministicCalculation}`)).toEqual([]);
  });
});
