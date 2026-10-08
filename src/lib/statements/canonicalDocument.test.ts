import { describe, expect, it } from "vitest";
import { safeValidateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { CANONICAL_SCHEMA_VERSION, composedStatements, lineFactId, totalFactId } from "./canonicalDocument";
import { composition, COMPARATIVE_DATES as DATES } from "./compositionFixture";

describe("composed statements: exactly the server's figures under the fixed fact identities", () => {
  const out = composedStatements(composition, DATES);
  it("one fact per composed line and period, and per total of each complete period — the ids the sign-off checks", () => {
    const ids = out.facts.map((f) => f.factId);
    expect(ids).toContain(lineFactId("current", "non_current_assets", "sfp.property_plant_and_equipment"));
    expect(ids).toContain(totalFactId("comparative", "totalAssetsMinor"));
    expect(ids.filter((i) => i.includes(":total:")).length).toBe(30); // 15 totals × 2 periods
    expect(ids.length).toBe(8 * 2 + 30 + 4); // + PPE's two accounts in two periods
    expect(new Set(ids).size).toBe(ids.length);
    // Amounts copied, never computed (hand-written expectations).
    const v = (id: string) => out.facts.find((f) => f.factId === id)!.value!.minorUnits;
    expect([v(lineFactId("current", "sci", "sci.revenue")), v(totalFactId("current", "profitOrLossMinor")), v(totalFactId("comparative", "totalEquityAndLiabilitiesMinor"))])
      .toEqual([3050000n, 510000n, 2880000n]);
    // Every fact carries the reporting input's identity as its trial-balance source (the readiness stale check).
    expect(new Set(out.facts.map((f) => f.provenance.source.sourceHash))).toEqual(new Set(["a".repeat(64)]));
  });
  it("each composed line casts its accounts: PPE is a SUBTOTAL of line:detail:sfp:1500 and :1510, whose facts are the lineage amounts", () => {
    const sfp = out.statements.find((s) => s.type === "STATEMENT_OF_FINANCIAL_POSITION")!;
    const lines = sfp.sections.flatMap((s) => s.lines);
    const ppe = lines.find((l) => l.lineId === "line:non_current_assets:sfp.property_plant_and_equipment")!;
    expect([ppe.role, ppe.castingChildLineIds]).toEqual(["SUBTOTAL", ["line:detail:sfp:1500", "line:detail:sfp:1510"]]);
    const v = (id: string) => out.facts.find((f) => f.factId === id)!.value!.minorUnits;
    expect([v("fact:current:account:1500"), v("fact:current:account:1510"), v("fact:comparative:account:1510")]).toEqual([2000000n, -600000n, -400000n]);
    expect(lines.find((l) => l.lineId === "line:detail:sfp:1510")!.factBindings).toEqual([{ periodId: "CURRENT", factId: "fact:current:account:1510" }, { periodId: "COMPARATIVE_1", factId: "fact:comparative:account:1510" }]);
  });
  it("the comparative period's dates are the input's; without them, a composed comparative is refused", () => {
    expect(out.comparativePeriods).toEqual([{ periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false }]);
    expect(() => composedStatements(composition, null)).toThrow(/period dates were not supplied/);
  });
  it("the assembled statements validate against the canonical model", () => {
    const doc = {
      schemaVersion: CANONICAL_SCHEMA_VERSION, reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 }, entity: { legalName: "Synthetic SME" },
      period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 }, comparativePeriods: out.comparativePeriods,
      framework: { kind: "IFRS_FOR_SMES" }, presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
      statements: out.statements, notes: [], noteReferences: [], accountingPolicies: [], textualDisclosures: [], facts: out.facts, provenanceOrigin: "TRIAL_BALANCE_DERIVED",
    };
    const r = safeValidateCanonicalReport(doc);
    expect(r.status === "VALID" ? [] : r.issues.slice(0, 5)).toEqual([]);
  });
});
