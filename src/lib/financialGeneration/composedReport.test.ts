import { describe, expect, it } from "vitest";
import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import type { NotesStatus } from "@/lib/notes/notesStatus";
import { composition, COMPARATIVE_DATES } from "@/lib/statements/compositionFixture";
import { ingestEvidence } from "@/lib/financialEvidence/intake";
import type { EvidenceType, PeriodRole } from "@/lib/financialEvidence/types";
import { PRIOR_OPENING_CASH_LINE_KEY } from "./applyEvidence";
import { assembleComposedReport, compositionCoverage, evaluateComposedReport, reportContentHash, type ComposedReportInput } from "./composedReport";

const H = (c: string) => c.repeat(64);
const req = (requirementId: string, kind: "DISCLOSURE" | "SCHEDULE" | "STATEMENT", status: string, textId?: string) => ({ requirementId, kind, blocking: true, status, ...(textId ? { textId } : {}) });
const notes = (over: Record<string, string> = {}): NotesStatus => ({
  state: "evaluated", contract: "fs-notes-status/2", packId: "ifrs-for-smes/2015", compositionSha256: H("b"), periodYear: 2026, blockers: [], statusSha256: H("c"),
  requirements: [
    req("smes.note.compliance", "DISCLOSURE", over.compliance ?? "provided", "t-compliance"),
    req("smes.note.policies", "DISCLOSURE", over.policies ?? "provided", "t-policies"),
    req("smes.schedule.ppe", "SCHEDULE", over.ppe ?? "reconciled"),
  ],
} as NotesStatus);
const input = (over: Partial<ComposedReportInput> = {}): ComposedReportInput => ({
  reportId: "rpt-1", reportVersion: 1, companyId: "c1", legalName: "Synthetic SME Limited", composition,
  currentDates: { start: "2026-01-01", end: "2026-12-31" }, comparativeDates: COMPARATIVE_DATES,
  dependencies: { dependenciesSha256: H("d"), compositionSha256: H("b"), notesStatusSha256: H("c"), comparativeStatusSha256: H("e") },
  notes: notes(), evidence: [], cashScope: { current: [], comparative: null },
  disclosures: [
    { requirementId: "smes.note.compliance", textId: "t-compliance", body: "Prepared under the IFRS for SMEs.", sourceRef: null },
    { requirementId: "smes.note.policies", textId: "t-policies", body: "Historical cost.", sourceRef: "Policies v1" },
    { requirementId: "smes.note.policies", textId: "t-old", body: "Superseded wording.", sourceRef: null },
  ],
  ...over,
});

describe("assembled report: the server's statements, notes and dependencies in one document", () => {
  const r = assembleComposedReport(input());
  it("forms a valid canonical report bound to the reporting dependencies", () => {
    expect(r.report).not.toBeNull();
    expect((r.report as unknown as { reportingDependencies: unknown }).reportingDependencies).toEqual(input().dependencies);
  });
  it("uses only the wording the notes status names as in force — superseded text never appears", () => {
    const d = r.report!.textualDisclosures;
    expect(d.find((x) => x.disclosureId === "smes.note.policies")?.text).toBe("Historical cost.");
    expect(d.some((x) => x.text === "Superseded wording.")).toBe(false);
  });
  it("the checklist is the server's notes status: provided only when the named requirement is satisfied", () => {
    const area = (n: NotesStatus) => assembleComposedReport(input({ notes: n })).report!.textualDisclosures.filter((x) => x.disclosureId.startsWith("checklist:")).map((x) => `${x.disclosureId}=${x.text.split(":")[0]}`);
    expect(area(notes())).toEqual(["checklist:accounting-policies=PROVIDED", "checklist:basis-of-preparation=PROVIDED", "checklist:supporting-notes=PROVIDED"]);
    expect(area(notes({ policies: "missing" }))).toContain("checklist:accounting-policies=MISSING");
    expect(area(notes({ ppe: "closing_mismatch" }))).toContain("checklist:supporting-notes=MISSING");
  });
  it("mapping coverage is the composition's own count (here: every account presented)", () => {
    expect(compositionCoverage(composition)).toEqual({ total: 2, unmapped: 0, ambiguous: 0 });
    expect(r.report!.textualDisclosures.find((x) => x.disclosureId === "mapping:coverage")?.text).toBe("total=2;unmapped=0;ambiguous=0");
  });
  it("is deterministic: the same inputs give the same bytes and the same content hash", () => {
    const again = assembleComposedReport(input());
    expect(canonicalStringify(again.report)).toBe(canonicalStringify(r.report));
    expect(reportContentHash(again.report!)).toBe(reportContentHash(r.report!));
  });
  it("the canonical rule pack verifies the composed statements independently: totals cast, the position balances, no duplicate concept", () => {
    const e = evaluateComposedReport(r.report!, () => "2027-01-01T00:00:00.000Z");
    const on = (rule: string) => e.findings.filter((f) => f.ruleId === rule && f.outcome !== "NOT_APPLICABLE").map((f) => f.outcome);
    expect(on("subtotal-casting").length).toBeGreaterThan(0);
    expect(new Set(on("subtotal-casting"))).toEqual(new Set(["PASS"]));
    expect(new Set(on("sfp-equation"))).toEqual(new Set(["PASS"]));
    expect(on("duplicate-detection").filter((o) => o !== "PASS")).toEqual([]);
  });
  it("a total that does not equal its parts is caught by the rule pack, not trusted", () => {
    const c = structuredClone(composition) as typeof composition;
    (c.totals.current as Record<string, string>).totalAssetsMinor = "3300001";
    const e = evaluateComposedReport(assembleComposedReport(input({ composition: c })).report!, () => "2027-01-01T00:00:00.000Z");
    expect(e.findings.some((f) => f.ruleId === "subtotal-casting" && f.outcome === "FAIL" && f.affected.lineId === "line:sfp:total:totalAssetsMinor")).toBe(true);
  });
});

describe("the comparative year's opening cash comes only from the signed prior-year cash-flow statement", () => {
  const parse = (evidenceType: EvidenceType, text: string, periodRole: PeriodRole) => {
    const r = ingestEvidence({ companyId: "c1", evidenceType, periodRole, reportingPeriodId: "FY2026", currency: "TZS", scale: 2, text });
    if (r.outcome !== "PARSED") throw new Error(r.diagnostics.map((d) => d.code).join(","));
    return r.batch;
  };
  const LEDGER = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nP1,2025-03-31,1000,Customers,9000.00,,OPERATING,Receipts from customers\nP2,2025-06-30,1000,Suppliers,,6200.00,OPERATING,Payments to suppliers\n";
  const CURRENT = parse("TRANSACTION_LEDGER", "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nC1,2026-03-31,1000,Customers,5000.00,,OPERATING,Receipts from customers\nC2,2026-06-30,1000,Suppliers,,4000.00,OPERATING,Payments to suppliers\n", "CURRENT");
  const PRIOR = (key: string) => `statement_type,line_key,line_label,amount\nCASH_FLOWS,${key},Cash at 1 January 2025,10000.00\n`;
  const cmpFact = (r: ReturnType<typeof assembleComposedReport>, re: RegExp) => {
    const line = r.report!.statements.find((s) => s.type === "STATEMENT_OF_CASH_FLOWS")!.sections.flatMap((s) => s.lines).find((l) => re.test(l.lineId));
    const id = line?.factBindings.find((b) => b.periodId === "COMPARATIVE_1")?.factId;
    return id ? r.report!.facts.find((f) => f.factId === id)!.value.minorUnits : null;
  };
  it("with it: opening 10,000.00 + net 2,800.00 = closing 12,800.00 (hand-computed), and the batch is recorded as used", () => {
    const r = assembleComposedReport(input({ evidence: [CURRENT, parse("TRANSACTION_LEDGER", LEDGER, "COMPARATIVE"), parse("PRIOR_PERIOD_STATEMENTS", PRIOR(PRIOR_OPENING_CASH_LINE_KEY), "COMPARATIVE")] }));
    expect([cmpFact(r, /opening/), cmpFact(r, /closing/)]).toEqual([1000000n, 1280000n]);
    expect(r.use.some((u) => u.evidenceType === "PRIOR_PERIOD_STATEMENTS" && u.used)).toBe(true);
  });
  it("without it (or under another key): no opening, no closing — nothing derived backwards from the comparative balance sheet", () => {
    for (const ev of [[CURRENT, parse("TRANSACTION_LEDGER", LEDGER, "COMPARATIVE")], [CURRENT, parse("TRANSACTION_LEDGER", LEDGER, "COMPARATIVE"), parse("PRIOR_PERIOD_STATEMENTS", PRIOR("cash_and_cash_equivalents_sfp"), "COMPARATIVE")]]) {
      const r = assembleComposedReport(input({ evidence: ev }));
      expect([cmpFact(r, /opening/), cmpFact(r, /closing/)]).toEqual([null, null]);
      expect(r.diagnostics.some((d) => d.code === "OPENING_CASH_MISSING")).toBe(true);
    }
  });
});
