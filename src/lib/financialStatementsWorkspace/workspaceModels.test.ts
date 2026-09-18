import { describe, expect, it } from "vitest";
import { FRAMEWORK_PROFILES, profileForDbValue, statementTitle } from "./frameworkProfiles";
import { composeStatements } from "./statementComposition";
import { deriveNoteNumbering } from "./noteNumbering";
import { resolveComparativeSource } from "./comparativeSource";
import { deriveReportingPeriod } from "./reportingPeriod";
import { buildSources } from "./sourcesModel";
import { buildStructure } from "./structureModel";
import { createTrialBalanceAdapter, type ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";

const base = { currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: null, isRetainedEarnings: null, isPayrollAccount: null, sourceUploadId: "u", sourceHash: "e".repeat(64) };
const L = (o: Partial<ReviewedTrialBalanceAccountLine> & Pick<ReviewedTrialBalanceAccountLine, "accountKey" | "accountName" | "statement" | "classification" | "normalBalance" | "balance">): ReviewedTrialBalanceAccountLine => ({ ...base, ...o });

async function report(overrides: Partial<CanonicalFinancialStatementReport> = {}): Promise<CanonicalFinancialStatementReport> {
  const lines = [
    L({ accountKey: "1", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 100 }),
    L({ accountKey: "3", accountName: "Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 100 }),
    L({ accountKey: "4", accountName: "Sales", statement: "income_statement", classification: "revenue", normalBalance: "credit", balance: 50 }),
    L({ accountKey: "5", accountName: "Costs", statement: "income_statement", classification: "operating_expenses", normalBalance: "debit", balance: 20 }),
  ];
  const x = await createTrialBalanceAdapter().normalize({ companyId: "c", periodYear: 2025, reviewedAccountLines: lines });
  return validateCanonicalReport({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 },
    entity: { legalName: "E" },
    period: { periodId: "CURRENT", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025 },
    comparativePeriods: [],
    framework: { kind: "IFRS" },
    presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
    statements: x.statements,
    notes: [],
    noteReferences: [],
    accountingPolicies: [],
    textualDisclosures: [],
    facts: x.facts,
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
    ...overrides,
  });
}

describe("framework profiles", () => {
  it("resolves each DB value and never defaults an unknown or null value", () => {
    expect(profileForDbValue("full_ifrs")?.kind).toBe("IFRS");
    expect(profileForDbValue("ifrs_for_smes")?.kind).toBe("IFRS_FOR_SMES");
    expect(profileForDbValue("ipsas_accrual")?.kind).toBe("IPSAS_ACCRUAL");
    expect(profileForDbValue("ipsas_cash")?.kind).toBe("IPSAS_CASH");
    expect(profileForDbValue(null)).toBeNull();
    expect(profileForDbValue("gaap")).toBeNull();
  });

  it("keeps framework terminology separate", () => {
    expect(FRAMEWORK_PROFILES.IFRS.terminology.netResult).toMatch(/Profit/);
    expect(FRAMEWORK_PROFILES.IPSAS_ACCRUAL.terminology.netResult).toMatch(/Surplus/);
    expect(FRAMEWORK_PROFILES.IFRS.terminology.netResult).not.toMatch(/Surplus/);
    expect(statementTitle(FRAMEWORK_PROFILES.IPSAS_ACCRUAL, "STATEMENT_OF_PROFIT_OR_LOSS", "x")).toBe("Statement of Financial Performance");
    expect(statementTitle(FRAMEWORK_PROFILES.IFRS, "STATEMENT_OF_PROFIT_OR_LOSS", "x")).toBe("Statement of Profit or Loss");
    expect(FRAMEWORK_PROFILES.IPSAS_CASH.expectedStatements.map((e) => e.kind)).not.toContain("STATEMENT_OF_FINANCIAL_POSITION");
  });
});

describe("statement composition", () => {
  it("presents SFP and P&L, and represents SOCIE, cash flow as evidence gaps with requirements — never silently omitted", async () => {
    const c = composeStatements({ profile: FRAMEWORK_PROFILES.IFRS, report: await report(), comparativeAvailable: true, cashPerimeterReviewed: false });
    const by = Object.fromEntries(c.entries.map((e) => [e.kind, e]));
    expect(by.STATEMENT_OF_FINANCIAL_POSITION.status).toBe("PRESENT");
    expect(by.STATEMENT_OF_PROFIT_OR_LOSS.status).toBe("PRESENT");
    expect(by.STATEMENT_OF_CHANGES_IN_EQUITY.status).toBe("EVIDENCE_GAP");
    expect(by.STATEMENT_OF_CHANGES_IN_EQUITY.evidenceRequirements.length).toBeGreaterThan(0);
    expect(by.STATEMENT_OF_CASH_FLOWS.status).toBe("EVIDENCE_GAP");
    expect(by.STATEMENT_OF_COMPREHENSIVE_INCOME.status).toBe("UNDETERMINED");
    expect(c.blockers.some((b) => b.includes("Statement of Cash Flows"))).toBe(true);
    expect(c.blockers.some((b) => b.includes("Statement of Changes in Equity"))).toBe(true);
  });

  it("reports a missing comparative as a blocker", async () => {
    const c = composeStatements({ profile: FRAMEWORK_PROFILES.IFRS, report: await report(), comparativeAvailable: false, cashPerimeterReviewed: false });
    expect(c.blockers.some((b) => b.includes("Comparative-period figures are missing"))).toBe(true);
  });

  it("models budget-vs-actual only for the IPSAS frameworks", async () => {
    const ifrs = composeStatements({ profile: FRAMEWORK_PROFILES.IFRS, report: await report(), comparativeAvailable: true, cashPerimeterReviewed: false });
    const ipsas = composeStatements({ profile: FRAMEWORK_PROFILES.IPSAS_ACCRUAL, report: await report(), comparativeAvailable: true, cashPerimeterReviewed: false });
    expect(ifrs.entries.some((e) => e.kind === "BUDGET_VS_ACTUAL")).toBe(false);
    expect(ipsas.entries.find((e) => e.kind === "BUDGET_VS_ACTUAL")).toMatchObject({ requirement: "CONDITIONAL", status: "EVIDENCE_GAP" });
  });

  it("gives IPSAS cash a precise unsupported boundary and never presents an accrual statement", async () => {
    const c = composeStatements({ profile: FRAMEWORK_PROFILES.IPSAS_CASH, report: null, comparativeAvailable: true, cashPerimeterReviewed: true });
    expect(c.entries.every((e) => e.status === "UNSUPPORTED")).toBe(true);
    expect(c.entries.map((e) => e.kind)).toEqual(["STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS", "BUDGET_VS_ACTUAL"]);
    expect(c.entries[0].evidenceRequirements.join(" ")).toMatch(/opening cash/i);
    expect(c.blockers.length).toBeGreaterThan(0);
  });
});

describe("note numbering", () => {
  it("is empty and diagnostic-free when the report has no notes", async () => {
    const r = deriveNoteNumbering(await report());
    expect(r.numberByNoteId.size).toBe(0);
    expect(r.diagnostics).toEqual([]);
  });

  it("numbers by first reference on the face, independent of stored note order, and flags orphans", async () => {
    const r0 = await report();
    const lineA = r0.statements[0].sections[0].lines[0].lineId;
    const lineB = r0.statements[1].sections[0].lines[0].lineId;
    const notes = [
      { noteId: "n-z", noteNumber: "", title: "Z", monetaryFactIds: [] },
      { noteId: "n-a", noteNumber: "", title: "A", monetaryFactIds: [] },
      { noteId: "n-orphan", noteNumber: "", title: "Orphan", monetaryFactIds: [] },
    ];
    const refs = [
      { noteReferenceId: "r1", fromLineId: lineB, toNoteId: "n-a" },
      { noteReferenceId: "r2", fromLineId: lineA, toNoteId: "n-z" },
    ];
    const r = deriveNoteNumbering({ ...r0, notes, noteReferences: refs });
    expect(r.numberByNoteId.get("n-z")).toBe("1"); // referenced from the earlier line
    expect(r.numberByNoteId.get("n-a")).toBe("2");
    expect(r.numberByNoteId.get("n-orphan")).toBe("3");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["NOTE_NOT_REFERENCED"]);
    const reversed = deriveNoteNumbering({ ...r0, notes: [...notes].reverse(), noteReferences: [...refs].reverse() });
    expect([...reversed.numberByNoteId.entries()].sort()).toEqual([...r.numberByNoteId.entries()].sort());
  });

  it("reports references to missing notes", async () => {
    const r0 = await report();
    const r = deriveNoteNumbering({ ...r0, noteReferences: [{ noteReferenceId: "r1", fromLineId: r0.statements[0].sections[0].lines[0].lineId, toNoteId: "ghost" }] });
    expect(r.diagnostics.map((d) => d.code)).toContain("REFERENCE_TO_MISSING_NOTE");
  });
});

describe("comparative source", () => {
  const up = (id: string, year: number, over: Record<string, unknown> = {}) => ({ id, company_id: "c", period_year: year, status: "complete", is_valid: true, processing_result: {}, uploaded_at: "2026-01-0" + id.length, ...over });
  it("finds the prior-year complete upload of the same company only", () => {
    const r = resolveComparativeSource([up("a", 2024), up("b", 2024, { company_id: "other" }), up("cc", 2023)], "c", 2025);
    expect(r).toMatchObject({ state: "AVAILABLE", periodYear: 2024 });
  });
  it("reports missing and ineligible comparatives explicitly", () => {
    expect(resolveComparativeSource([up("a", 2023)], "c", 2025)).toMatchObject({ state: "MISSING" });
    expect(resolveComparativeSource([up("a", 2024, { status: "needs_review", is_valid: null })], "c", 2025)).toMatchObject({ state: "INELIGIBLE" });
  });
});

describe("reporting period", () => {
  it("uses the fiscal year end when set", () => {
    expect(deriveReportingPeriod(2025, "2020-06-30")).toEqual({ startDate: "2024-07-01", endDate: "2025-06-30", basis: "FISCAL_YEAR_END" });
  });
  it("flags calendar-year bounds as assumed when no fiscal year end exists", () => {
    expect(deriveReportingPeriod(2025, null)).toEqual({ startDate: "2025-01-01", endDate: "2025-12-31", basis: "CALENDAR_YEAR_ASSUMED" });
  });
  it("clamps 29 February safely", () => {
    expect(deriveReportingPeriod(2025, "2024-02-29").endDate).toBe("2025-02-28");
  });
});

describe("sources and structure", () => {
  it("never shows an unavailable input as working, and keeps extraction unavailable even if intake is enabled", () => {
    const cmp = resolveComparativeSource([], "c", 2025);
    for (const enabled of [false, true]) {
      const s = buildSources({ currentUpload: { id: "u", file_name: "tb.xlsx", status: "complete", is_valid: true }, periodYear: 2025, comparative: cmp, documentReviewEnabled: enabled });
      expect(s.find((e) => e.id === "existing-statement-intake")?.status).toBe("UNAVAILABLE");
      expect(s.find((e) => e.id === "prior-financial-statements")?.status).toBe("UNAVAILABLE");
      expect(s.find((e) => e.id === "comparative-period")?.status).toBe("MISSING");
      expect(s.find((e) => e.id === "reviewed-trial-balance")?.status).toBe("AVAILABLE");
    }
  });

  it("makes every unresolved setting a blocking diagnostic instead of defaulting", () => {
    const m = buildStructure({
      profile: null,
      rawFramework: null,
      currency: null,
      periodYear: 2025,
      period: { startDate: "2025-01-01", endDate: "2025-12-31", basis: "CALENDAR_YEAR_ASSUMED" },
      comparativePeriodYear: null,
      comparativeAvailable: false,
      composition: null,
      mapping: { totalAccounts: 3, unmapped: [{ accountCode: "9", accountName: "X" }], ambiguous: [{ accountCode: "8", accountName: "Y", placements: ["a", "b"] }] },
    });
    expect(m.diagnostics.map((d) => d.code).sort()).toEqual(["ACCOUNTS_AMBIGUOUS", "ACCOUNTS_UNMAPPED", "CURRENCY_NOT_SET", "FRAMEWORK_NOT_SET", "PERIOD_BASIS_ASSUMED"]);
    expect(m.hasBlocking).toBe(true);
    expect(m.mapping?.complete).toBe(false);
    expect(m.mapping?.mapped).toBe(1);
  });

  it("requires a comparative when the framework does", () => {
    const m = buildStructure({
      profile: FRAMEWORK_PROFILES.IFRS,
      rawFramework: "full_ifrs",
      currency: "TZS",
      periodYear: 2025,
      period: { startDate: "2025-01-01", endDate: "2025-12-31", basis: "FISCAL_YEAR_END" },
      comparativePeriodYear: null,
      comparativeAvailable: false,
      composition: null,
      mapping: { totalAccounts: 2, unmapped: [], ambiguous: [] },
    });
    expect(m.diagnostics.map((d) => d.code)).toEqual(["COMPARATIVE_MISSING"]);
    expect(m.mapping?.complete).toBe(true);
  });
});
