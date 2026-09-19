import { describe, expect, it } from "vitest";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { ingestEvidence, type IntakeRequest } from "@/lib/financialEvidence/intake";
import type { EvidenceBatch, EvidenceType } from "@/lib/financialEvidence/types";
import { prepareTrialBalanceReport } from "@/lib/financialStatementsWorkspace/evaluationOrchestrator";
import { profileForKind } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { InMemoryFinancialStatementReportRepository } from "@/lib/financialStatementsWorkspace/reportRepository";
import type { ReviewedTrialBalanceAccountLine } from "@/lib/financialStatementsWorkspace/trialBalanceAdapter";
import { applyEvidence } from "./applyEvidence";
import { BUDGET_GAP_DISCLOSURE_ID, BUDGET_NOTE_ID, budgetFromReport, checklistDisclosureId, checklistFromReport, MAPPING_COVERAGE_DISCLOSURE_ID } from "./persistedAuthority";

const line = (o: Partial<ReviewedTrialBalanceAccountLine> & Pick<ReviewedTrialBalanceAccountLine, "accountKey" | "accountName" | "statement" | "classification" | "normalBalance" | "balance">): ReviewedTrialBalanceAccountLine => ({
  currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: false, isRetainedEarnings: false, isPayrollAccount: false, sourceUploadId: "u1", sourceHash: "a".repeat(64), ...o,
});
const TB = [
  line({ accountKey: "1000", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 5_000_000, isCashAccount: true }),
  line({ accountKey: "1500", accountName: "PPE", statement: "balance_sheet", classification: "non_current_assets", normalBalance: "debit", balance: 10_000_000 }),
  line({ accountKey: "2000", accountName: "Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 7_000_000 }),
  line({ accountKey: "3000", accountName: "Share capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 8_000_000 }),
  line({ accountKey: "4000", accountName: "Sales", statement: "income_statement", classification: "revenue", normalBalance: "credit", balance: 12_000_000 }),
  line({ accountKey: "6000", accountName: "Opex", statement: "income_statement", classification: "operating_expenses", normalBalance: "debit", balance: 9_000_000 }),
];
const base = async () =>
  (await prepareTrialBalanceReport({ companyId: "c1", periodYear: 2025, entityLegalName: "Acme", framework: "ifrs_for_smes", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, comparativePeriods: [], reviewedAccountLines: TB }, new InMemoryFinancialStatementReportRepository())).snapshot.report;
const parse = (evidenceType: EvidenceType, text: string, extra: Partial<IntakeRequest> = {}): EvidenceBatch => {
  const r = ingestEvidence({ companyId: "c1", evidenceType, periodRole: "CURRENT", reportingPeriodId: "FY2025", currency: "TZS", scale: 2, text, ...extra });
  if (r.outcome !== "PARSED") throw new Error("rejected");
  return r.batch;
};
const HEADER = "line_key,line_label,nature,original_budget,final_budget,explanation\n";
const BUDGET = HEADER + "line:detail:pl:4000,Sales,REVENUE,10000000,11000000,Council approved a reallocation\nline:detail:pl:6000,Opex,EXPENSE,2500000,,\n";
const profile = profileForKind("IFRS_FOR_SMES");
const run = async (budget: string | null, extra: EvidenceBatch[] = [], coverage?: { total: number; unmapped: number; ambiguous: number }) =>
  applyEvidence({ report: await base(), profile, cashAccountKeys: ["1000"], evidence: [...(budget ? [parse("BUDGET", budget)] : []), ...extra], mappingCoverage: coverage });
const hash = (r: { report: unknown }) => sha256Hex(canonicalStringify(r.report));

describe("the budget comparison lives IN the stored report", () => {
  it("records comparison and variance facts, a note, and one line record per budget line", async () => {
    const r = await run(BUDGET);
    const report = r.report!;
    expect(report.notes.some((n) => n.noteId === BUDGET_NOTE_ID)).toBe(true);
    expect(report.textualDisclosures.filter((d) => d.disclosureId.startsWith("budget:line:"))).toHaveLength(2);
    expect(report.facts.filter((f) => f.factId.startsWith("fact:budget:comparison:"))).toHaveLength(2);
    expect(report.facts.filter((f) => f.factId.startsWith("fact:budget:variance:"))).toHaveLength(2);
  });

  it("a stored version reproduces its own comparison exactly, without the live evidence", async () => {
    const r = await run(BUDGET);
    const live = r.budgetActual;
    const stored = budgetFromReport(r.report!);
    if (live?.status !== "GENERATED" || stored?.status !== "GENERATED") throw new Error("not generated");
    const key = (l: (typeof live.lines)[number]) => [l.lineKey, l.budget.minorUnits, l.actual?.minorUnits ?? null, l.variance?.minorUnits ?? null, l.direction, l.variancePercent, l.preparerExplanation, l.comparisonBasis];
    expect(stored.lines.map(key)).toEqual([...live.lines].sort((a, b) => (a.lineKey < b.lineKey ? -1 : 1)).map(key));
  });

  it("a BUDGET-ONLY change changes the report's content identity (so it is a new persisted version, not a silent side effect)", async () => {
    const a = await run(BUDGET);
    const changed = await run(BUDGET.replace("10000000", "10000001"));
    const explained = await run(BUDGET.replace("Council approved a reallocation", "Council approved a different reallocation"));
    expect(hash(changed)).not.toBe(hash(a));
    expect(hash(explained)).not.toBe(hash(a));
    // exact replay is identical
    expect(hash(await run(BUDGET))).toBe(hash(a));
    // and removing the budget changes it back to the budget-less identity
    expect(hash(await run(null))).not.toBe(hash(a));
  });

  it("a budget that cannot be compared is recorded as an explicit GAP, never a silent absence", async () => {
    const r = await run(BUDGET, [], undefined);
    void r;
    const usd = applyEvidence({ report: await base(), profile, cashAccountKeys: ["1000"], evidence: [parse("BUDGET", BUDGET, { currency: "USD" })] });
    expect(usd.report!.textualDisclosures.some((d) => d.disclosureId === BUDGET_GAP_DISCLOSURE_ID)).toBe(true);
    expect(budgetFromReport(usd.report!)).toMatchObject({ status: "EVIDENCE_GAP" });
  });

  it("a budget line with no unique actual is recorded as UNMATCHED (no actual is assumed)", async () => {
    const r = await run(BUDGET + "not.a.line,Ghost,EXPENSE,100,,\n");
    const rec = r.report!.textualDisclosures.filter((d) => d.disclosureId.startsWith("budget:line:")).map((d) => JSON.parse(d.text) as { lineKey: string; matched: boolean });
    expect(rec.find((x) => x.lineKey === "not.a.line")!.matched).toBe(false);
    expect(rec.filter((x) => x.matched)).toHaveLength(2);
  });

  it("a report with no budget carries no budget records at all", async () => {
    const r = await run(null);
    expect(r.report!.notes.some((n) => n.noteId === BUDGET_NOTE_ID)).toBe(false);
    expect(r.report!.textualDisclosures.some((d) => d.disclosureId.startsWith("budget:"))).toBe(false);
    expect(budgetFromReport(r.report!)).toBeNull();
  });
});

describe("the disclosure checklist and mapping coverage live IN the stored report", () => {
  it("records every framework disclosure area as MISSING when no notes evidence exists", async () => {
    const r = await run(null);
    const recs = r.report!.textualDisclosures.filter((d) => d.disclosureId.startsWith("checklist:"));
    expect(recs.map((d) => d.disclosureId).sort()).toEqual(profile.disclosureAreas.map((a) => checklistDisclosureId(a.id)).sort());
    expect(recs.every((d) => d.text.startsWith("MISSING:"))).toBe(true);
  });

  it("records PROVIDED / NOT_APPLICABLE states from reviewed notes evidence, with row provenance", async () => {
    const notes = parse("NOTES_AND_POLICIES", 'kind,key,title,body,checklist_ref\nPOLICY,pol.basis,Basis,"Prepared under the IFRS for SMEs.",basis-of-preparation\nPOLICY,pol.rev,Revenue,"Revenue is recognised when control transfers.",accounting-policies\nNOTE,note.na,Other,"There are no further notes.",supporting-notes\n', { currency: undefined, scale: undefined });
    const r = await run(null, [notes]);
    const by = Object.fromEntries(r.report!.textualDisclosures.filter((d) => d.disclosureId.startsWith("checklist:")).map((d) => [d.disclosureId, d]));
    expect(by[checklistDisclosureId("basis-of-preparation")].text.startsWith("PROVIDED:")).toBe(true);
    expect(by[checklistDisclosureId("accounting-policies")].text.startsWith("PROVIDED:")).toBe(true);
    expect(by[checklistDisclosureId("basis-of-preparation")].provenance.locator).toMatchObject({ kind: "EVIDENCE_ROW", batchId: notes.evidenceBatchId });
  });

  it("a stored version reproduces its OWN checklist from the report alone — the live evidence is never consulted", async () => {
    const notes = parse("NOTES_AND_POLICIES", ["kind,key,title,body,checklist_ref,applicability", 'POLICY,pol.basis,Basis,"Prepared under the IFRS for SMEs.",basis-of-preparation,', 'POLICY,pol.other,Other,"None apply here.",accounting-policies,NOT_APPLICABLE', ""].join("\n"), { currency: undefined, scale: undefined });
    const r = await run(null, [notes]);
    const stored = checklistFromReport(r.report!, profile.disclosureAreas);
    expect(stored.map((c) => [c.areaId, c.state, c.satisfiedBy])).toEqual(r.checklist.map((c) => [c.areaId, c.state, c.satisfiedBy]));
    expect(stored.find((c) => c.areaId === "basis-of-preparation")).toMatchObject({ state: "PROVIDED", satisfiedBy: "pol.basis" });
    expect(stored.find((c) => c.areaId === "accounting-policies")?.state).toBe("NOT_APPLICABLE_WITH_RATIONALE");
    // a report with no record for an area (or no checklist at all) reads as MISSING, never as PROVIDED
    const none = checklistFromReport({ ...r.report!, textualDisclosures: [] }, profile.disclosureAreas);
    expect(none.every((c) => c.state === "MISSING")).toBe(true);
    expect(none.map((c) => c.label)).toEqual(profile.disclosureAreas.map((a) => a.label));
  });

  it("changing a disclosure changes the report's content identity", async () => {
    const mk = (body: string) => parse("NOTES_AND_POLICIES", `kind,key,title,body,checklist_ref\nPOLICY,pol.basis,Basis,"${body}",basis-of-preparation\n`, { currency: undefined, scale: undefined });
    expect(hash(await run(null, [mk("Prepared under the IFRS for SMEs.")]))).not.toBe(hash(await run(null, [mk("Prepared under IFRS.")])));
  });

  it("mapping coverage is recorded exactly when it is supplied", async () => {
    const withCov = await run(null, [], { total: 6, unmapped: 0, ambiguous: 0 });
    expect(withCov.report!.textualDisclosures.find((d) => d.disclosureId === MAPPING_COVERAGE_DISCLOSURE_ID)!.text).toBe("total=6;unmapped=0;ambiguous=0");
    const flagged = await run(null, [], { total: 6, unmapped: 1, ambiguous: 2 });
    expect(flagged.report!.textualDisclosures.find((d) => d.disclosureId === MAPPING_COVERAGE_DISCLOSURE_ID)!.text).toBe("total=6;unmapped=1;ambiguous=2");
    expect((await run(null)).report!.textualDisclosures.some((d) => d.disclosureId === MAPPING_COVERAGE_DISCLOSURE_ID)).toBe(false);
    expect(hash(flagged)).not.toBe(hash(withCov));
  });
});
