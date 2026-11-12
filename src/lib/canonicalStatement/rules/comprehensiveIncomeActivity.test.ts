// DEFECT S2-A02 — a post-closing trial balance (the year's profit already closed into retained earnings) composed a nil
// statement of comprehensive income beside a balanced statement of financial position, and nothing said so.
//
// Rule `comprehensive-income-activity` (rule pack 2.4.0) FAILs, HIGH, when no line of the current period's statement of
// comprehensive income carries a non-zero amount while the statement of financial position does. HIGH makes it a sign-off
// blocker (fs_unresolved_blocking_count; the server compilation's findings) unless a reviewer records ACCEPT_FINDING with a
// reason (a genuinely dormant entity). Detection only: nothing is presented differently.
//
// Fixture, by hand (TZS, two decimals; the composition fixture's figures): the pre-closing year presents revenue 30,500.00,
// cost of sales 24,500.00 and tax 900.00 — three non-zero SCI lines → PASS. The post-closing variant of the same year: the
// three SCI lines are gone (or present at 0.00), profit 5,100.00 sits in equity (15,900.00 + 5,100.00 = 21,000.00), and the SFP
// still carries PPE 14,000.00, cash 19,000.00, borrowings 8,000.00 and payables 4,000.00 → FAIL, HIGH, actionable.
import { describe, expect, it } from "vitest";
import { composition, COMPARATIVE_DATES } from "@/lib/statements/compositionFixture";
import type { Composition } from "@/lib/statements/composition";
import type { NotesStatus } from "@/lib/notes/notesStatus";
import { assembleComposedReport, evaluateComposedReport } from "@/lib/financialGeneration/composedReport";
import type { CanonicalFinancialStatementReport, MonetaryFact, Statement } from "../types";
import { CANONICAL_RULE_PACK_V2, CANONICAL_RULE_PACK_V2_RULES, CANONICAL_RULE_PACK_V2_4_RULES } from "./rulePack";
import { buildUncheckedRuleContext, testReport } from "./testReport";
import { comprehensiveIncomeActivityRule } from "./comprehensiveIncomeActivity";
import { ZERO_TOLERANCE } from "../money";

const H = (c: string) => c.repeat(64);
const notes = { state: "evaluated", contract: "fs-notes-status/2", packId: "ifrs-for-smes/2015", compositionSha256: H("b"), periodYear: 2026, blockers: [], statusSha256: H("c"), requirements: [] } as unknown as NotesStatus;
const compose = (c: Composition) => assembleComposedReport({
  reportId: "rpt-post-closing", reportVersion: 1, companyId: "c1", legalName: "Synthetic SME Limited", composition: c,
  currentDates: { start: "2026-01-01", end: "2026-12-31" }, comparativeDates: COMPARATIVE_DATES,
  dependencies: { dependenciesSha256: H("d"), compositionSha256: H("b"), notesStatusSha256: H("c"), comparativeStatusSha256: H("e") },
  notes, evidence: [], cashScope: { current: [], comparative: null }, disclosures: [],
}).report!;

/** Both years after closing entries (the post-closing export): no SCI line has an amount; each year's profit is inside equity
 *  (current 15,900.00 + 5,100.00 = 21,000.00; comparative 13,500.00 + 3,100.00 = 16,600.00). With keepZeroLines the SCI lines are
 *  still composed, at 0.00 in both years. */
function postClosing(keepZeroLines: boolean): Composition {
  const c = structuredClone(composition) as Composition & { lines: Array<Record<string, unknown>>; totals: Record<"current" | "comparative", Record<string, string>> };
  c.lines = c.lines.flatMap((l) => {
    if (l.statement !== "SCI") return l.lineId === "sfp.equity_attributable_to_owners" ? [{ ...l, current: { amountMinor: "2100000", accounts: 2 }, comparative: { amountMinor: "1660000", accounts: 2, asReportedMinor: "1660000", restated: false } }] : [l];
    return keepZeroLines ? [{ ...l, current: { amountMinor: "0", accounts: 1 }, comparative: { amountMinor: "0", accounts: 1, asReportedMinor: "0", restated: false } }] : [];
  });
  const nil = { incomeMinor: "0", expensesExcludingTaxMinor: "0", profitBeforeTaxMinor: "0", taxExpenseMinor: "0", profitOrLossMinor: "0" };
  Object.assign(c.totals.current, nil, { equityAccountsMinor: "2100000", totalEquityMinor: "2100000" });
  Object.assign(c.totals.comparative, nil, { equityAccountsMinor: "1660000", totalEquityMinor: "1660000" });
  return c as Composition;
}

const findingsOf = (report: CanonicalFinancialStatementReport) => evaluateComposedReport(report, () => "2027-01-01T00:00:00.000Z");
const ofRule = (e: ReturnType<typeof findingsOf>) => e.findings.filter((f) => f.ruleId === "comprehensive-income-activity");

describe("comprehensive-income-activity (S2-A02): a post-closing trial balance is detected", () => {
  it("post-closing: the composed SCI carries no non-zero figure while the SFP does → FAIL, HIGH, actionable, in the pack in force (2.4.0)", () => {
    const e = findingsOf(compose(postClosing(false)));
    expect(e.rulePackVersion).toBe("2.4.0");
    const f = ofRule(e);
    expect(f.map((x) => [x.outcome, x.failureSeverity, x.actionable])).toEqual([["FAIL", "HIGH", true]]);
    expect(f[0].deterministicCalculation).toContain("no line of the statement of comprehensive income carries a non-zero amount for CURRENT");
    expect(f[0].remediationGuidance).toMatch(/pre-closing trial balance/);
    expect(f[0].remediationGuidance).toMatch(/dormant/);
  });

  it("post-closing with the income and expense lines still present at 0.00 → FAIL as well", () => {
    expect(ofRule(findingsOf(compose(postClosing(true)))).map((x) => x.outcome)).toEqual(["FAIL"]);
  });

  it("pre-closing (the ordinary case): revenue 30,500.00, cost of sales 24,500.00, tax 900.00 → PASS; no other finding changes", () => {
    const e = findingsOf(compose(composition));
    expect(ofRule(e).map((x) => [x.outcome, x.actionable])).toEqual([["PASS", false]]);
  });

  it("income and expense that net to nil are still activity → PASS (the rule tests presence, not the result)", () => {
    const c = structuredClone(composition) as Composition & { lines: Array<Record<string, unknown>> };
    c.lines = c.lines.map((l) => (l.lineId === "sci.revenue" ? { ...l, current: { amountMinor: "2540000", accounts: 1 } } : l.lineId === "sci.tax_expense" ? { ...l, current: { amountMinor: "90000", accounts: 1 } } : l));
    expect(ofRule(findingsOf(compose(c))).map((x) => x.outcome)).toEqual(["PASS"]);
  });

  it("nothing anywhere (an empty position) and no statement of comprehensive income are NOT_APPLICABLE, never PASS by default", () => {
    const fact = (factId: string, minor: bigint, periodId = "CURRENT"): MonetaryFact => ({ factId, version: 1, value: { currency: "TZS", scale: 2, minorUnits: minor }, reportingPeriod: { periodId, isComparative: periodId !== "CURRENT" }, signConvention: "DEBIT_POSITIVE",
      provenance: { source: { sourceDocumentId: "s", sourceHash: H("a"), artifactKind: "TRIAL_BALANCE" }, locator: { kind: "MANUAL", note: "t" }, extractionMethod: "TRIAL_BALANCE_DERIVED", extractionConfidence: { kind: "CERTAIN" }, originalText: "t" }, supersedesVersion: null });
    const line = (lineId: string, factId: string) => ({ lineId, label: lineId, concept: lineId, role: "DETAIL" as const, normalBalance: "DEBIT_NORMAL" as const, isContra: false, factBindings: [{ periodId: "CURRENT", factId }], castingChildLineIds: [] });
    const sfp: Statement = { statementId: "stmt:sfp", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "SFP", sections: [{ sectionId: "s", label: "s", lines: [line("line:cash", "f:cash")] }] };
    const sci: Statement = { statementId: "stmt:sci", type: "STATEMENT_OF_PROFIT_OR_LOSS", title: "SCI", sections: [{ sectionId: "s", label: "s", lines: [line("line:rev", "f:rev")] }] };
    const run = (statements: Statement[], facts: MonetaryFact[]) => comprehensiveIncomeActivityRule.evaluate(buildUncheckedRuleContext(testReport({ statements, facts }), ZERO_TOLERANCE)).map((r) => r.outcome);
    expect(run([sfp, sci], [fact("f:cash", 0n), fact("f:rev", 0n)])).toEqual(["NOT_APPLICABLE"]);
    expect(run([sfp], [fact("f:cash", 100n)])).toEqual(["NOT_APPLICABLE"]);
    expect(run([sfp, sci], [fact("f:cash", 100n), fact("f:rev", 0n)])).toEqual(["FAIL"]);
    expect(run([sfp, sci], [fact("f:cash", 100n), fact("f:rev", 5n)])).toEqual(["PASS"]);
    // Only the CURRENT period decides: a comparative-only figure is not current activity.
    expect(run([sfp, { ...sci, sections: [{ sectionId: "s", label: "s", lines: [{ ...line("line:rev", "f:rev"), factBindings: [{ periodId: "CURRENT", factId: "f:rev" }, { periodId: "P", factId: "f:rev-p" }] }] }] }],
      [fact("f:cash", 100n), fact("f:rev", 0n), fact("f:rev-p", 9n, "P")])).toEqual(["FAIL"]);
  });

  it("rule pack 2.3.0 is untouched (recorded evaluations stay reproducible): same identity, same rules, no new rule", () => {
    // INTEGRATION: authored against main (where the pack below was 2.2.0), now beside the declared-nil casting change that made it 2.3.0.
    // Either way the pack that existed before this rule is unchanged by it: same identity, same rule count, no comprehensive-income-activity.
    expect(CANONICAL_RULE_PACK_V2).toEqual({ rulePackId: "canonical-statement-rules", rulePackVersion: "2.3.0" });
    expect(CANONICAL_RULE_PACK_V2_RULES.map((r) => `${r.ruleId}@${r.ruleVersion}`)).not.toContain("comprehensive-income-activity@1.0.0");
    expect(CANONICAL_RULE_PACK_V2_RULES).toHaveLength(14);
  });

  it("rule pack 2.4.0 is exactly pack 2.3.0 plus this rule, nothing else", () => {
    expect(CANONICAL_RULE_PACK_V2_4_RULES).toHaveLength(15);
    expect(CANONICAL_RULE_PACK_V2_4_RULES.slice(0, 14)).toEqual(CANONICAL_RULE_PACK_V2_RULES);
    expect(CANONICAL_RULE_PACK_V2_4_RULES[14]!.ruleId).toBe("comprehensive-income-activity");
  });
});
