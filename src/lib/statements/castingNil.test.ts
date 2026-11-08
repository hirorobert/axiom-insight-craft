// Regression proofs for the two registered casting defects, at the level where they arise (the composed canonical document read by the
// REAL subtotal-casting rule):
//   DEFECT-FS-RESTATED-COMPARATIVE-CASTING-001   a restated comparative: the restatement child exists in the comparative column only
//   DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001   an account (or line) present in one period only
// Before this change both reported INSUFFICIENT_EVIDENCE on the parent line for the period in which the child has no row. The fix is
// a declaration by the composed line (castingNilPeriodIds) - no fact is invented, nothing is added up in the builder - and the rule
// stays fail-closed everywhere else (a real casting error, a bound child with no fact, a report that does not declare it).
import { describe, expect, it } from "vitest";
import { buildRuleContext } from "@/lib/canonicalStatement/rules/ruleEngine";
import { subtotalCastingRule, subtotalCastingRuleV2 } from "@/lib/canonicalStatement/rules/subtotalCasting";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import { safeValidateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { CANONICAL_SCHEMA_VERSION, composedStatements } from "./canonicalDocument";
import { composition as base, COMPARATIVE_DATES as DATES } from "./compositionFixture";
import type { Composition } from "./composition";

const CERT = "11111111-1111-4111-8111-111111111111";
const PRIOR = "22222222-2222-4222-8222-222222222222";
const PAYABLES = "sfp.trade_and_other_payables";
const acct = (period: "current" | "comparative", key: string, name: string, amt: string) => ({ period, accountKey: key, accountCode: key, accountName: name, certificationId: period === "current" ? CERT : PRIOR,
  classification: "current_liabilities", amountMinor: amt, certifiedAmountMinor: amt, adjustmentIds: [], assignmentId: CERT, assignmentSeq: 1, kind: "account", bridgeId: null, restatementId: null });
const restatement = (amt: string) => ({ period: "comparative", accountKey: null, accountCode: null, accountName: null, certificationId: PRIOR, classification: null, amountMinor: amt, certifiedAmountMinor: null,
  adjustmentIds: [], assignmentId: null, assignmentSeq: null, kind: "restatement", bridgeId: null, restatementId: "33333333-3333-4333-8333-333333333333" });

/** The shared fixture with the payables line given the stated lineage and figures (every other line unchanged). */
function withPayables(cur: string, cmp: string, lineage: unknown[], restated = false): Composition {
  const c = structuredClone(base) as unknown as { lines: Array<Record<string, unknown>> };
  const l = c.lines.find((x) => x.lineId === PAYABLES)!;
  l.current = { amountMinor: cur, accounts: 1 };
  l.comparative = { amountMinor: cmp, accounts: 1, asReportedMinor: restated ? "310000" : cmp, restated };
  l.lineage = lineage;
  return c as unknown as Composition;
}

function report(c: Composition, strip = false) {
  const out = composedStatements(c, DATES);
  const statements = strip
    ? out.statements.map((s) => ({ ...s, sections: s.sections.map((sec) => ({ ...sec, lines: sec.lines.map(({ castingNilPeriodIds: _drop, ...rest }) => rest) })) }))
    : out.statements;
  const doc = { schemaVersion: CANONICAL_SCHEMA_VERSION, reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 }, entity: { legalName: "Synthetic SME" },
    period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 }, comparativePeriods: out.comparativePeriods, framework: { kind: "IFRS_FOR_SMES" },
    presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n }, statements, notes: [], noteReferences: [], accountingPolicies: [],
    textualDisclosures: [], facts: out.facts, provenanceOrigin: "TRIAL_BALANCE_DERIVED" };
  const v = safeValidateCanonicalReport(doc);
  if (v.status !== "VALID") throw new Error(JSON.stringify(v.issues.slice(0, 3)));
  return v.report;
}
const casting = (c: Composition, strip = false, rule = subtotalCastingRuleV2) => rule.evaluate(buildRuleContext(report(c, strip), ZERO_TOLERANCE));
const forLine = (rs: ReturnType<typeof casting>) => rs.filter((r) => String((r.affected as { lineId?: string }).lineId).endsWith(PAYABLES)).map((r) => `${r.periodId}:${r.outcome}`).sort();
const everything = (rs: ReturnType<typeof casting>) => [...new Set(rs.map((r) => r.outcome))];

describe("a restated comparative casts (DEFECT-FS-RESTATED-COMPARATIVE-CASTING-001)", () => {
  // current 4,000.00 = account 2000; comparative 3,200.00 = account 2000 3,100.00 + approved restatement +100.00
  const restated = () => withPayables("400000", "320000", [acct("current", "2000", "Trade payables", "400000"), acct("comparative", "2000", "Trade payables", "310000"), restatement("10000")], true);
  it("the payables line passes in BOTH periods and every casting result of the report passes", () => {
    const rs = casting(restated());
    expect(forLine(rs)).toEqual(["COMPARATIVE_1:PASS", "CURRENT:PASS"]);
    expect(everything(rs)).toEqual(["PASS"]);
  });
  it("the restatement child is bound to the comparative only and its line declares the current period nil - no fact was invented", () => {
    const out = composedStatements(restated(), DATES);
    const child = out.statements.flatMap((s) => s.sections.flatMap((x) => x.lines)).find((l) => l.lineId.startsWith("line:restatement:"))!;
    expect(child.factBindings.map((b) => b.periodId)).toEqual(["COMPARATIVE_1"]);
    const parent = out.statements.flatMap((s) => s.sections.flatMap((x) => x.lines)).find((l) => l.lineId === `line:current_liabilities:${PAYABLES}`)!;
    expect(parent.castingNilPeriodIds).toEqual(["CURRENT", "COMPARATIVE_1"]);
    expect(out.facts.filter((f) => f.factId.includes("restatement"))).toHaveLength(1);
  });
  it("a real casting error is still a FAIL: the comparative says 3,200.01 but its rows add to 3,200.00", () => {
    const rs = casting(withPayables("400000", "320001", [acct("current", "2000", "Trade payables", "400000"), acct("comparative", "2000", "Trade payables", "310000"), restatement("10000")], true));
    expect(forLine(rs)).toEqual(["COMPARATIVE_1:FAIL", "CURRENT:PASS"]);
  });
  it("rule pack v1 is unchanged: version 1.0.0 ignores the declaration, so v1 evaluations stay reproducible", () => {
    expect([subtotalCastingRule.ruleVersion, subtotalCastingRuleV2.ruleVersion]).toEqual(["1.0.0", "1.1.0"]);
    expect(forLine(casting(restated(), false, subtotalCastingRule))).toEqual(["COMPARATIVE_1:PASS", "CURRENT:INSUFFICIENT_EVIDENCE"]);
  });
  it("a report that does not declare it stays fail-closed (an unbound child is missing evidence, never zero)", () => {
    expect(forLine(casting(restated(), true))).toEqual(["COMPARATIVE_1:PASS", "CURRENT:INSUFFICIENT_EVIDENCE"]);
  });
});

describe("an account present in one period only casts (DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001)", () => {
  it("a NEW current-year account: current 4,000.00 = 3,000.00 + 1,000.00 (2100 exists this year only); comparative 3,200.00 = 2000 only", () => {
    const rs = casting(withPayables("400000", "320000", [acct("current", "2000", "Trade payables", "300000"), acct("current", "2100", "Accrued fees", "100000"), acct("comparative", "2000", "Trade payables", "320000")]));
    expect(forLine(rs)).toEqual(["COMPARATIVE_1:PASS", "CURRENT:PASS"]);
    expect(everything(rs)).toEqual(["PASS"]);
  });
  it("an account that existed LAST year only (closed this year): comparative 3,200.00 = 2,000.00 + 1,200.00; current 4,000.00 = 2000 only", () => {
    const rs = casting(withPayables("400000", "320000", [acct("current", "2000", "Trade payables", "400000"), acct("comparative", "2000", "Trade payables", "200000"), acct("comparative", "2200", "Old creditor", "120000")]));
    expect(forLine(rs)).toEqual(["COMPARATIVE_1:PASS", "CURRENT:PASS"]);
  });
  it("a one-period account does not hide an error: current says 4,000.01 but 3,000.00 + 1,000.00 is 4,000.00", () => {
    const rs = casting(withPayables("400001", "320000", [acct("current", "2000", "Trade payables", "300000"), acct("current", "2100", "Accrued fees", "100000"), acct("comparative", "2000", "Trade payables", "320000")]));
    expect(forLine(rs)).toEqual(["COMPARATIVE_1:PASS", "CURRENT:FAIL"]);
  });
  it("without the declaration the new account is missing evidence for the other period (the old behaviour, still the default for extracted reports)", () => {
    const rs = casting(withPayables("400000", "320000", [acct("current", "2000", "Trade payables", "300000"), acct("current", "2100", "Accrued fees", "100000"), acct("comparative", "2000", "Trade payables", "320000")]), true);
    expect(forLine(rs)).toEqual(["COMPARATIVE_1:INSUFFICIENT_EVIDENCE", "CURRENT:PASS"]);
  });
});

describe("the declaration turns only ABSENCE into nil", () => {
  it("a child that is bound to a period but whose fact is missing is still missing evidence", () => {
    const c = withPayables("400000", "320000", [acct("current", "2000", "Trade payables", "400000"), acct("comparative", "2000", "Trade payables", "310000"), restatement("10000")], true);
    const out = composedStatements(c, DATES);
    const dropped = out.facts.filter((f) => f.factId !== "fact:current:account:2000");
    const doc = { schemaVersion: CANONICAL_SCHEMA_VERSION, reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 }, entity: { legalName: "Synthetic SME" },
      period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 }, comparativePeriods: out.comparativePeriods, framework: { kind: "IFRS_FOR_SMES" },
      presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n }, statements: out.statements, notes: [], noteReferences: [], accountingPolicies: [],
      textualDisclosures: [], facts: dropped, provenanceOrigin: "TRIAL_BALANCE_DERIVED" };
    const v = safeValidateCanonicalReport(doc);
    // The document no longer validates (a binding names a fact that is not in the report) - it cannot reach the rule as a PASS.
    expect(v.status).toBe("INVALID");
  });
  it("the schema refuses a nil declaration on a line with no children, or for a period the line has no value of its own", () => {
    const out = composedStatements(withPayables("400000", "320000", [acct("current", "2000", "Trade payables", "400000"), acct("comparative", "2000", "Trade payables", "320000")]), DATES);
    const tamper = (mutate: (l: { castingNilPeriodIds?: string[]; castingChildLineIds: string[]; lineId: string; factBindings: Array<{ periodId: string }> }) => void) => {
      const statements = structuredClone(out.statements) as unknown as Array<{ sections: Array<{ lines: Array<never> }> }>;
      const line = statements.flatMap((s) => s.sections.flatMap((x) => x.lines)).find((l: { lineId: string }) => l.lineId === `line:current_liabilities:${PAYABLES}`) as never;
      mutate(line);
      return safeValidateCanonicalReport({ schemaVersion: CANONICAL_SCHEMA_VERSION, reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 }, entity: { legalName: "Synthetic SME" },
        period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 }, comparativePeriods: out.comparativePeriods, framework: { kind: "IFRS_FOR_SMES" },
        presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n }, statements, notes: [], noteReferences: [], accountingPolicies: [],
        textualDisclosures: [], facts: out.facts, provenanceOrigin: "TRIAL_BALANCE_DERIVED" }).status;
    };
    expect(tamper(() => undefined)).toBe("VALID");
    expect(tamper((l) => { l.castingNilPeriodIds = ["COMPARATIVE_9"]; })).toBe("INVALID");
    expect(tamper((l) => { l.castingChildLineIds = []; l.castingNilPeriodIds = ["CURRENT"]; })).toBe("INVALID");
  });
});
