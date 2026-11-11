// DEFECT S2-A01 — a transfer between two cash accounts inside the perimeter (bank → petty cash) is not a cash flow.
//
// IFRS for SMEs (2015 edition) Section 7 presents inflows and outflows of cash and cash equivalents; a movement between two
// accounts that are both cash and cash equivalents is neither (IAS 7.9 states it explicitly; paragraph citations unverified —
// the standard's text is not in this repository). The per-account roll-forward (cashLedgerAuthority.ts)
// still needs BOTH legs in the ledger, so the ledger marks them (activity TRANSFER_BETWEEN_CASH_ACCOUNTS, evidence schema
// 1.1.0, column counter_cash_account_code naming the other account) and the direct-method generator leaves them out of every
// presented line and of the net movement.
//
// Expected figures, computed by hand (TZS, two decimals; minor units = cents):
//   Bank 1010:        comparative 2,000.00 → current 1,400.00; movement −600.00
//                      ledger: +400.00 customers − 1,000.00 transfer to petty cash = −600.00  → roll-forward PASS
//   Petty cash 1030:   comparative   100.00 → current 1,100.00; movement +1,000.00
//                      ledger: +1,000.00 transfer from the bank                    = +1,000.00 → roll-forward PASS
//   Presented:        operating "Receipts from customers" 400.00; net operating 400.00; no transfer line;
//                      net increase 400.00; opening 2,100.00 (comparative perimeter); closing 2,500.00 = 1,400.00 + 1,100.00
import { describe, expect, it } from "vitest";
import { createTrialBalanceAdapter, type ReviewedTrialBalanceAccountLine } from "@/lib/financialStatementsWorkspace/trialBalanceAdapter";
import { profileForKind } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { buildRuleContext } from "@/lib/canonicalStatement/rules/ruleEngine";
import { runCanonicalRulePackV2 } from "@/lib/canonicalStatement/rules/rulePack";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport, type RuleEvaluationRecord } from "@/lib/canonicalStatement/types";
import { ingestEvidence } from "@/lib/financialEvidence/intake";
import type { EvidenceBatch, EvidenceType } from "@/lib/financialEvidence/types";
import { applyEvidence } from "./applyEvidence";

const HASH = "b".repeat(64);
type Acc = { key: string; name: string; cls: "current_assets" | "equity"; normal: "debit" | "credit"; cur: number; prior: number; cash?: boolean };
const ACCOUNTS: Acc[] = [
  { key: "1010", name: "Bank", cls: "current_assets", normal: "debit", cur: 1_400, prior: 2_000, cash: true },
  { key: "1030", name: "Petty cash", cls: "current_assets", normal: "debit", cur: 1_100, prior: 100, cash: true },
  { key: "1099", name: "Fixed deposit 6 months", cls: "current_assets", normal: "debit", cur: 500, prior: 500 },
  { key: "3000", name: "Share capital", cls: "equity", normal: "credit", cur: 3_000, prior: 2_600 },
];

async function tbReport(): Promise<CanonicalFinancialStatementReport> {
  const lines: ReviewedTrialBalanceAccountLine[] = ACCOUNTS.flatMap((a) =>
    ([["CURRENT", a.cur, false], ["PRIOR_2024", a.prior, true]] as const).map(([periodId, balance, isComparative]) => ({
      accountKey: a.key, accountName: a.name, statement: "balance_sheet" as const, classification: a.cls, normalBalance: a.normal, balance, currency: "TZS", scale: 2,
      periodId, isComparative, isCashAccount: a.cash ?? false, isRetainedEarnings: false, isPayrollAccount: false, sourceUploadId: "u1", sourceHash: HASH,
    })),
  );
  const x = await createTrialBalanceAdapter().normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines });
  return validateCanonicalReport({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "report-transfers", companyId: "company-1", reportVersion: 1 },
    entity: { legalName: "Transfer Test Ltd" },
    period: { periodId: "CURRENT", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025 },
    comparativePeriods: [{ periodId: "PRIOR_2024", startDate: "2024-01-01", endDate: "2024-12-31", periodYear: 2024, isRestated: false }],
    framework: { kind: "IFRS_FOR_SMES" },
    presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
    statements: x.statements, notes: x.notes, noteReferences: [], accountingPolicies: x.accountingPolicies, textualDisclosures: x.textualDisclosures, facts: x.facts, provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  });
}

const ingest = (evidenceType: EvidenceType, text: string, money = true) =>
  ingestEvidence({ companyId: "company-1", evidenceType, periodRole: "CURRENT", reportingPeriodId: "FY2025", ...(money ? { currency: "TZS", scale: 2 } : {}), text });
const parse = (evidenceType: EvidenceType, text: string, money = true): EvidenceBatch => {
  const r = ingest(evidenceType, text, money);
  if (r.outcome !== "PARSED") throw new Error(`rejected ${r.diagnostics.map((d) => d.code)}`);
  return r.batch;
};
const MAP = "account_key,category,effect,include_in_cash_flow,note\n1010,BANK_ACCOUNT,ADD,Y,\n1030,CASH_ON_HAND,ADD,Y,\n1099,EXCLUDED_NON_CASH,ADD,N,not a cash equivalent\n";
const HEADER = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line,counter_cash_account_code\n";
const CUSTOMERS = "T1,2025-03-01,1010,Customer receipts,400.00,,OPERATING,Receipts from customers,\n";
const TO_PETTY = "X1,2025-04-01,1010,Cash withdrawn for petty cash,,1000.00,TRANSFER_BETWEEN_CASH_ACCOUNTS,Transfer to petty cash,1030\n";
const FROM_BANK = "X2,2025-04-01,1030,Cash received from the bank,1000.00,,TRANSFER_BETWEEN_CASH_ACCOUNTS,Transfer from the bank,1010\n";

const run = async (ledgerText: string) => {
  const base = await tbReport();
  return applyEvidence({ report: base, profile: profileForKind("IFRS_FOR_SMES"), cashAccountKeys: ["1010", "1030"], evidence: [parse("CASH_ACCOUNT_MAP", MAP, false), parse("TRANSACTION_LEDGER", ledgerText)] });
};
const evaluate = (report: CanonicalFinancialStatementReport | null): readonly RuleEvaluationRecord[] => runCanonicalRulePackV2(buildRuleContext(report!, ZERO_TOLERANCE), () => "2026-01-01T00:00:00.000Z");
const cfFacts = (report: CanonicalFinancialStatementReport) => Object.fromEntries(report.facts.filter((f) => f.factId.startsWith("fact:line:cf:")).map((f) => [f.factId, f.value!.minorUnits]));
const codes = (r: ReturnType<typeof ingest>) => (r.outcome === "PARSED" ? r.batch.diagnostics : r.diagnostics).filter((d) => d.severity === "ERROR").map((d) => d.code);

describe("transfers between two cash accounts inside the perimeter (S2-A01)", () => {
  it("count in each account's roll-forward, are excluded from every presented line and from the net increase", async () => {
    const r = await run(HEADER + CUSTOMERS + TO_PETTY + FROM_BANK);
    expect(r.diagnostics.filter((d) => d.severity === "ERROR")).toEqual([]);
    const cf = r.report!.statements.find((s) => s.type === "STATEMENT_OF_CASH_FLOWS")!;
    const labels = cf.sections.flatMap((s) => s.lines).map((l) => l.label);
    expect(labels.some((l) => /transfer/i.test(l))).toBe(false);
    expect(cf.sections.map((s) => s.sectionId)).toEqual(["section:cf:operating", "section:cf:cash"]);
    // Hand-computed (see the header): every cash-flow figure of the current period, in cents.
    const facts = cfFacts(r.report!);
    const current = Object.keys(facts).filter((k) => k.endsWith(":CURRENT"));
    const detail = current.filter((k) => /^fact:line:cf:operating:[0-9a-f]{10}:CURRENT$/.test(k));
    expect(current).toHaveLength(5); // one operating line, its net, net increase, opening, closing — nothing for the transfer
    expect(detail).toHaveLength(1);
    expect(facts[detail[0]]).toBe(40_000n);
    expect(facts["fact:line:cf:operating:net:CURRENT"]).toBe(40_000n);
    expect(facts["fact:line:cf:net-increase:CURRENT"]).toBe(40_000n);
    expect(facts["fact:line:cf:opening:CURRENT"]).toBe(210_000n);
    expect(facts["fact:line:cf:closing:CURRENT"]).toBe(250_000n);
    // Roll-forward: both legs are in each account's ledger movement and both accounts reconcile.
    expect(r.cashLedgerAuthority?.status).toBe("ESTABLISHED");
    expect(r.cashLedgerAuthority!.rows.map((x) => [x.accountKey, x.ledgerMovement.minorUnits, x.tbMovement?.minorUnits, x.difference?.minorUnits])).toEqual([
      ["1010", -60_000n, -60_000n, 0n],
      ["1030", 100_000n, 100_000n, 0n],
    ]);
    const f = evaluate(r.report);
    expect(f.filter((x) => x.ruleId === "cashflow-account-rollforward").map((x) => x.outcome)).toEqual(["PASS", "PASS"]);
    expect(f.filter((x) => x.ruleId === "cashflow-closing-cash-reconciliation" && x.outcome !== "NOT_APPLICABLE").map((x) => x.outcome)).toEqual(["PASS"]);
  });

  it("the ledger records schema 1.1.0 only when it carries the counter-account column; an existing ledger is read exactly as before (schema 1.0.0)", () => {
    const withTransfers = parse("TRANSACTION_LEDGER", HEADER + CUSTOMERS + TO_PETTY + FROM_BANK);
    expect(withTransfers.validationStatus).toBe("VALID");
    expect(withTransfers.schemaVersion).toBe("1.1.0");
    expect(withTransfers.document.schemaVersion).toBe("1.1.0");
    expect(withTransfers.document.columns).toEqual(["transaction_id", "date", "cash_account_code", "description", "receipt", "payment", "activity", "cash_flow_line", "counter_cash_account_code"]);
    const legacy = parse("TRANSACTION_LEDGER", "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nT1,2025-03-01,1010,Customer receipts,400.00,,OPERATING,Receipts from customers\n");
    expect(legacy.schemaVersion).toBe("1.0.0");
    expect(legacy.document.schemaVersion).toBe("1.0.0");
    expect(legacy.document.columns).toEqual(["transaction_id", "date", "cash_account_code", "description", "receipt", "payment", "activity", "cash_flow_line"]);
    expect(legacy.document.rows).toEqual([["T1", "2025-03-01", "1010", "Customer receipts", "400.00", "", "OPERATING", "Receipts from customers"]]);
  });

  it("fails closed: a transfer without the counter-account column, without a counter account, to itself, or a counter account on an ordinary row", () => {
    const legacyHeader = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\n";
    expect(codes(ingest("TRANSACTION_LEDGER", legacyHeader + "X1,2025-04-01,1010,To petty cash,,1000.00,TRANSFER_BETWEEN_CASH_ACCOUNTS,Transfer to petty cash\n"))).toContain("TRANSFER_NEEDS_COUNTER_ACCOUNT_COLUMN");
    expect(codes(ingest("TRANSACTION_LEDGER", HEADER + "X1,2025-04-01,1010,To petty cash,,1000.00,TRANSFER_BETWEEN_CASH_ACCOUNTS,Transfer to petty cash,\n"))).toContain("TRANSFER_COUNTER_ACCOUNT_REQUIRED");
    expect(codes(ingest("TRANSACTION_LEDGER", HEADER + "X1,2025-04-01,1010,To itself,,1000.00,TRANSFER_BETWEEN_CASH_ACCOUNTS,Transfer,1010\nX2,2025-04-01,1010,From itself,1000.00,,TRANSFER_BETWEEN_CASH_ACCOUNTS,Transfer,1010\n"))).toContain("TRANSFER_TO_SAME_ACCOUNT");
    expect(codes(ingest("TRANSACTION_LEDGER", HEADER + "T1,2025-03-01,1010,Customer receipts,400.00,,OPERATING,Receipts from customers,1030\n"))).toContain("COUNTER_ACCOUNT_ONLY_ON_TRANSFERS");
  });

  it("fails closed: a transfer leg whose other leg is missing or differs (money leaving the perimeter labelled as a transfer) is refused", () => {
    expect(codes(ingest("TRANSACTION_LEDGER", HEADER + CUSTOMERS + TO_PETTY))).toContain("TRANSFER_LEGS_DO_NOT_MATCH");
    const short = FROM_BANK.replace("1000.00,,", "900.00,,");
    expect(codes(ingest("TRANSACTION_LEDGER", HEADER + CUSTOMERS + TO_PETTY + short))).toContain("TRANSFER_LEGS_DO_NOT_MATCH");
    // Two legs in the same direction never net to zero either.
    expect(codes(ingest("TRANSACTION_LEDGER", HEADER + TO_PETTY + FROM_BANK.replace("1000.00,,", ",1000.00,")))).toContain("TRANSFER_LEGS_DO_NOT_MATCH");
  });

  it("fails closed: a transfer naming an account outside the cash perimeter is a ledger row on a non-cash account (CRITICAL, nothing reassigned)", async () => {
    // Both legs are recorded, so the ledger is internally consistent — but 1099 is mapped EXCLUDED_NON_CASH: the "transfer" is a
    // cash outflow into a 6-month deposit and must be presented as one. The roll-forward refuses it by name.
    const toDeposit = "X1,2025-04-01,1010,Placed on deposit,,1000.00,TRANSFER_BETWEEN_CASH_ACCOUNTS,Transfer to deposit,1099\nX2,2025-04-01,1099,Deposit placed,1000.00,,TRANSFER_BETWEEN_CASH_ACCOUNTS,Transfer from the bank,1010\n";
    const r = await run(HEADER + CUSTOMERS + toDeposit);
    expect(r.cashLedgerAuthority?.status).toBe("UNRESOLVED");
    expect(r.diagnostics.map((d) => d.code)).toContain("LEDGER_ROW_ACCOUNT_NOT_A_CASH_ACCOUNT");
    const fails = evaluate(r.report).filter((x) => x.ruleId === "cashflow-account-rollforward" && x.outcome === "FAIL");
    expect(fails.map((x) => x.failureSeverity)).toContain("CRITICAL");
    expect(fails.map((x) => x.deterministicCalculation).join(" ")).toContain("not an established cash account");
  });

  it("a ledger that records only transfers presents no statement (no cash flow to present; never a nil statement invented)", async () => {
    const r = await run(HEADER + TO_PETTY + FROM_BANK);
    expect(r.report!.statements.some((s) => s.type === "STATEMENT_OF_CASH_FLOWS")).toBe(false);
    expect(r.cashLedgerAuthority).toBeNull();
  });

  it("is order-independent: the legs in any order give the same figures", async () => {
    const a = await run(HEADER + CUSTOMERS + TO_PETTY + FROM_BANK);
    const b = await run(HEADER + FROM_BANK + TO_PETTY + CUSTOMERS);
    const strip = (r: typeof a) => Object.fromEntries(Object.entries(cfFacts(r.report!)).filter(([k]) => !/:operating:[0-9a-f]{10}:/.test(k)));
    expect(strip(b)).toEqual(strip(a));
  });
});
