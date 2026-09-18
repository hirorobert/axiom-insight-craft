import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatementRenderer } from "./StatementRenderer";
import { createTrialBalanceAdapter, type ReviewedTrialBalanceAccountLine } from "@/lib/financialStatementsWorkspace/trialBalanceAdapter";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { CANONICAL_SCHEMA_VERSION } from "@/lib/canonicalStatement/types";

const base = { currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: null, isRetainedEarnings: null, isPayrollAccount: null, sourceUploadId: "u", sourceHash: "c".repeat(64) };

async function render(lines: ReviewedTrialBalanceAccountLine[]) {
  const extraction = await createTrialBalanceAdapter().normalize({ companyId: "c", periodYear: 2025, reviewedAccountLines: lines });
  const report = validateCanonicalReport({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 },
    entity: { legalName: "Acme Ltd" },
    period: { periodId: "CURRENT", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025 },
    comparativePeriods: [],
    framework: { kind: "IFRS_FOR_SMES" },
    presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
    statements: extraction.statements,
    notes: [],
    noteReferences: [],
    accountingPolicies: [],
    textualDisclosures: [],
    facts: extraction.facts,
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  });
  return renderToStaticMarkup(createElement(StatementRenderer, { report, statement: report.statements[0] }));
}

describe("StatementRenderer", () => {
  it("renders accessible table semantics with a repeating header and per-line anchors", async () => {
    const html = await render([
      { ...base, accountKey: "1000", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 1500.5 },
      { ...base, accountKey: "3000", accountName: "Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 1500.5 },
    ]);
    expect(html).toContain("<thead");
    expect(html).toContain("table-header-group");
    expect(html).toContain('scope="col"');
    expect(html).toContain('id="fs-line-line:detail:sfp:1000"');
    expect(html).toContain("1500.50");
    expect(html).toContain("Total Assets");
  });

  it("renders a dash, never a fabricated zero, where a period has no value", async () => {
    const html = await render([{ ...base, accountKey: "1000", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 10 }]);
    // Total Liabilities has no children for this period, so its cell must be a dash.
    const row = html.split("</tr>").find((r) => r.includes("Total Liabilities</td>"));
    expect(row).toContain("—");
    expect(row).not.toContain(">0.00<");
  });
});
