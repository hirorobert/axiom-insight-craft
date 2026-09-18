import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatementRenderer } from "./StatementRenderer";
import { createTrialBalanceAdapter, type ReviewedTrialBalanceAccountLine } from "@/lib/financialStatementsWorkspace/trialBalanceAdapter";
import { FRAMEWORK_PROFILES } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { deriveNoteNumbering } from "@/lib/financialStatementsWorkspace/noteNumbering";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport, type ReportingFrameworkKind } from "@/lib/canonicalStatement/types";

const base = { currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: null, isRetainedEarnings: null, isPayrollAccount: null, sourceUploadId: "u", sourceHash: "c".repeat(64) };

async function buildReport(lines: ReviewedTrialBalanceAccountLine[], kind: ReportingFrameworkKind = "IFRS", extra: Partial<CanonicalFinancialStatementReport> = {}) {
  const extraction = await createTrialBalanceAdapter().normalize({ companyId: "c", periodYear: 2025, reviewedAccountLines: lines });
  return validateCanonicalReport({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 },
    entity: { legalName: "Acme Ltd" },
    period: { periodId: "CURRENT", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025 },
    comparativePeriods: [],
    framework: { kind },
    presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
    statements: extraction.statements,
    notes: [],
    noteReferences: [],
    accountingPolicies: [],
    textualDisclosures: [],
    facts: extraction.facts,
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
    ...extra,
  });
}

function html(report: CanonicalFinancialStatementReport, index: number, kind: ReportingFrameworkKind) {
  return renderToStaticMarkup(createElement(StatementRenderer, { report, statement: report.statements[index], profile: FRAMEWORK_PROFILES[kind], numbering: deriveNoteNumbering(report) }));
}

const sfp: ReviewedTrialBalanceAccountLine[] = [
  { ...base, accountKey: "1000", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 1500.5 },
  { ...base, accountKey: "1590", accountName: "Accumulated depreciation", statement: "balance_sheet", classification: "non_current_assets", normalBalance: "debit", balance: -200 },
  { ...base, accountKey: "3000", accountName: "Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 1300.5 },
  { ...base, accountKey: "4000", accountName: "Sales", statement: "income_statement", classification: "revenue", normalBalance: "credit", balance: 900 },
  { ...base, accountKey: "5000", accountName: "Costs", statement: "income_statement", classification: "operating_expenses", normalBalance: "debit", balance: 400 },
];

describe("StatementRenderer", () => {
  it("renders accessible table semantics, a repeating header, per-line anchors and a scroll container", async () => {
    const out = html(await buildReport(sfp), 0, "IFRS");
    expect(out).toContain("table-header-group");
    expect(out).toContain('scope="col"');
    expect(out).toContain('id="fs-line-line:detail:sfp:1000"');
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("1500.50");
    expect(out).toContain("Total Assets");
  });

  it("shows negative values in parentheses", async () => {
    const out = html(await buildReport(sfp), 0, "IFRS");
    expect(out).toContain("(200.00)");
    expect(out).not.toContain("-200.00");
  });

  it("renders a dash, never a fabricated zero, where a period has no value", async () => {
    const out = html(await buildReport(sfp), 0, "IFRS");
    const row = out.split("</tr>").find((r) => r.includes("Total Liabilities</td>"));
    expect(row).toContain("—");
    expect(row).not.toContain(">0.00<");
  });

  it("uses the framework profile's titles and terminology, and never another framework's", async () => {
    const ifrs = html(await buildReport(sfp, "IFRS"), 1, "IFRS");
    const ipsas = html(await buildReport(sfp, "IPSAS_ACCRUAL"), 1, "IPSAS_ACCRUAL");
    expect(ifrs).toContain("Statement of Profit or Loss");
    expect(ifrs).toContain("Profit/(loss) for the year");
    expect(ipsas).toContain("Statement of Financial Performance");
    expect(ipsas).toContain("Surplus/(deficit) for the period");
    expect(ipsas).not.toContain("Profit/(loss)");
    const ipsasSfp = html(await buildReport(sfp, "IPSAS_ACCRUAL"), 0, "IPSAS_ACCRUAL");
    expect(ipsasSfp).toContain("Total net assets/equity");
    expect(ipsasSfp).toContain("Total liabilities and net assets/equity");
  });

  it("presents the net result exactly", async () => {
    expect(html(await buildReport(sfp), 1, "IFRS")).toContain("500.00"); // 900 - 400
  });

  it("adds a Note column with deterministic references only when the report has real note references", async () => {
    const r0 = await buildReport(sfp);
    expect(html(r0, 0, "IFRS")).not.toContain(">Note<");
    const lineId = r0.statements[0].sections[0].lines[0].lineId;
    const r1 = await buildReport(sfp, "IFRS", { notes: [{ noteId: "n1", noteNumber: "", title: "Cash", monetaryFactIds: [] }], noteReferences: [{ noteReferenceId: "ref1", fromLineId: lineId, toNoteId: "n1" }] });
    const out = html(r1, 0, "IFRS");
    expect(out).toContain(">Note<");
    expect(out).toMatch(/text-center[^>]*>1</);
  });

  it("breaks the page before later statements when asked, for print", async () => {
    const r = await buildReport(sfp);
    const out = renderToStaticMarkup(createElement(StatementRenderer, { report: r, statement: r.statements[1], profile: FRAMEWORK_PROFILES.IFRS, numbering: null, startOnNewPage: true }));
    expect(out).toContain("print:break-before-page");
  });
});
