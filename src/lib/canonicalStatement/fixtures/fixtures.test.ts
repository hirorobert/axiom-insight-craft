import { describe, expect, it } from "vitest";
import { buildRuleContext } from "../rules/ruleEngine";
import { runCanonicalRulePackV1 } from "../rules/rulePack";
import { ZERO_TOLERANCE } from "../money";
import { validateCanonicalReport } from "../validation";
import { IFRS_FULL_FIXTURE } from "./ifrsFullFixture";
import { IFRS_FOR_SMES_FIXTURE } from "./ifrsForSmesFixture";
import { IPSAS_ACCRUAL_FIXTURE } from "./ipsasAccrualFixture";
import { IPSAS_CASH_FIXTURE } from "./ipsasCashFixture";
import { DEFECTIVE_FIXTURE } from "./defectiveFixture";
import type { RuleEvaluationRecord } from "../types";

function byRule(findings: readonly RuleEvaluationRecord[]): Map<string, RuleEvaluationRecord[]> {
  const map = new Map<string, RuleEvaluationRecord[]>();
  for (const f of findings) {
    map.set(f.ruleId, [...(map.get(f.ruleId) ?? []), f]);
  }
  return map;
}

function outcomes(findings: readonly RuleEvaluationRecord[]): string[] {
  return findings.map((f) => f.outcome);
}

function outcomeCountsByRule(findings: readonly RuleEvaluationRecord[]): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const f of findings) {
    result[f.ruleId] ??= {};
    result[f.ruleId][f.outcome] = (result[f.ruleId][f.outcome] ?? 0) + 1;
  }
  return result;
}

describe.each([
  ["IFRS full", IFRS_FULL_FIXTURE],
  ["IFRS for SMEs", IFRS_FOR_SMES_FIXTURE],
  ["IPSAS accrual", IPSAS_ACCRUAL_FIXTURE],
  ["IPSAS cash", IPSAS_CASH_FIXTURE],
])("golden fixture: %s", (_name, fixture) => {
  it("passes runtime validation — every fact/reference binding resolves and every structural invariant holds", () => {
    expect(() => validateCanonicalReport(fixture)).not.toThrow();
  });

  it("produces zero FAIL findings across the whole rule pack", () => {
    const ctx = buildRuleContext(fixture, ZERO_TOLERANCE);
    const findings = runCanonicalRulePackV1(ctx);
    const failures = findings.filter((f) => f.outcome === "FAIL");
    expect(failures).toEqual([]);
  });

  it("produces no unexpected INSUFFICIENT_EVIDENCE — every occurrence is an intentional, documented structural absence", () => {
    const ctx = buildRuleContext(fixture, ZERO_TOLERANCE);
    const findings = runCanonicalRulePackV1(ctx);
    // The golden fixtures are built so every rule either PASSes or is
    // legitimately NOT_APPLICABLE (e.g. IPSAS cash has no SFP) — none of
    // them should ever need to fall back to INSUFFICIENT_EVIDENCE.
    expect(findings.filter((f) => f.outcome === "INSUFFICIENT_EVIDENCE")).toEqual([]);
  });

  it("every finding carries a complete, well-formed finding contract", () => {
    const ctx = buildRuleContext(fixture, ZERO_TOLERANCE);
    const findings = runCanonicalRulePackV1(ctx);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.findingKey).toMatch(/^[0-9a-f]{64}$/);
      expect(f.evaluationId).toMatch(/^[0-9a-f]{64}$/);
      expect(f.ruleId).toBeTruthy();
      expect(f.ruleVersion).toBeTruthy();
      expect(f.rulePack.rulePackId).toBe("canonical-statement-rules");
      expect(f.engineVersion).toBeTruthy();
      expect(["PASS", "FAIL", "NOT_APPLICABLE", "INSUFFICIENT_EVIDENCE"]).toContain(f.outcome);
      expect(f.failureSeverity).toBeTruthy();
      expect(f.actionable).toBe(f.outcome === "FAIL" || f.outcome === "INSUFFICIENT_EVIDENCE");
      expect(f.status).toBe(f.actionable ? "OPEN" : "NOT_ACTIONABLE");
      expect(f.expectedRelationship).toBeTruthy();
      expect(f.deterministicCalculation).toBeTruthy();
      expect(f.remediationGuidance).toBeTruthy();
      expect(f.createdAt).toBeTruthy();
    }
  });

  it("no PASS or NOT_APPLICABLE result is ever rendered as an open finding", () => {
    const ctx = buildRuleContext(fixture, ZERO_TOLERANCE);
    const findings = runCanonicalRulePackV1(ctx);
    const nonActionable = findings.filter((f) => f.outcome === "PASS" || f.outcome === "NOT_APPLICABLE");
    expect(nonActionable.length).toBeGreaterThan(0);
    for (const f of nonActionable) {
      expect(f.actionable).toBe(false);
      expect(f.status).toBe("NOT_ACTIONABLE");
    }
  });
});

describe("IFRS full fixture — specific structural assertions", () => {
  const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
  const findings = runCanonicalRulePackV1(ctx);
  const grouped = byRule(findings);

  it("explicit expected-outcome snapshot per rule (verified against the actual engine output — not a hand guess)", () => {
    expect(outcomeCountsByRule(findings)).toEqual({
      "sfp-equation": { PASS: 2 },
      "subtotal-casting": { PASS: 10 },
      "note-to-face-reconciliation": { NOT_APPLICABLE: 2, PASS: 1 },
      "comparative-period-alignment": { PASS: 3 },
      "currency-scale-consistency": { PASS: 30 },
      "cashflow-closing-cash-reconciliation": { PASS: 2 },
      "movement-reconciliation": { PASS: 1 },
      "duplicate-detection": { PASS: 1 },
      "missing-comparative-detection": { PASS: 5 },
      "orphaned-note-reference-detection": { PASS: 3 },
    });
  });

  it("SFP equation PASSes for both current and comparative periods", () => {
    expect(outcomes(grouped.get("sfp-equation") ?? [])).toEqual(["PASS", "PASS"]);
  });

  it("multiple notes referencing one face line are both individually reconciled/considered (NOT_APPLICABLE, narrative-only)", () => {
    const noteRefFindings = grouped.get("note-to-face-reconciliation") ?? [];
    expect(noteRefFindings.length).toBeGreaterThanOrEqual(3); // PPE (PASS) + ageing (N/A) + related-party (N/A)
  });

  it("duplicate labels with different concepts (\"Total\" on both total_assets and total_liabilities_and_equity) are never flagged", () => {
    const duplicateFindings = grouped.get("duplicate-detection") ?? [];
    expect(duplicateFindings.every((f) => f.outcome !== "FAIL")).toBe(true);
  });

  it("the contra P&L expense line participates correctly in a passing casting check", () => {
    const castingFindings = grouped.get("subtotal-casting") ?? [];
    const profitFindings = castingFindings.filter((f) => f.affected.lineId === "pnl-profit");
    expect(profitFindings.length).toBeGreaterThan(0);
    expect(profitFindings.every((f) => f.outcome === "PASS")).toBe(true);
  });

  it("the movement schedule (opening + additions - disposals = closing) PASSes", () => {
    expect(outcomes(grouped.get("movement-reconciliation") ?? [])).toEqual(["PASS"]);
  });
});

describe("IPSAS accrual fixture — otherMovements ADD branch", () => {
  it("the infrastructure-assets movement schedule (with a revaluation ADD) PASSes", () => {
    const ctx = buildRuleContext(IPSAS_ACCRUAL_FIXTURE, ZERO_TOLERANCE);
    const findings = runCanonicalRulePackV1(ctx);
    const movementFindings = findings.filter((f) => f.ruleId === "movement-reconciliation");
    expect(outcomes(movementFindings)).toEqual(["PASS"]);
  });
});

describe("IPSAS cash fixture — no statement of financial position at all", () => {
  const ctx = buildRuleContext(IPSAS_CASH_FIXTURE, ZERO_TOLERANCE);
  const findings = runCanonicalRulePackV1(ctx);
  const grouped = byRule(findings);

  it("the SFP equation rule is NOT_APPLICABLE — there is no SFP to check", () => {
    expect(outcomes(grouped.get("sfp-equation") ?? [])).toEqual(["NOT_APPLICABLE"]);
  });

  it("the cash-flow closing-cash rule is NOT_APPLICABLE, not INSUFFICIENT_EVIDENCE — expected for cash-basis reporting", () => {
    const cfFindings = grouped.get("cashflow-closing-cash-reconciliation") ?? [];
    expect(cfFindings.length).toBeGreaterThan(0);
    expect(cfFindings.every((f) => f.outcome === "NOT_APPLICABLE")).toBe(true);
  });
});

describe("IFRS for SMEs fixture — a restated comparative", () => {
  it("the restated comparative period is present and marked as such", () => {
    expect(IFRS_FOR_SMES_FIXTURE.comparativePeriods[0].isRestated).toBe(true);
    expect(IFRS_FOR_SMES_FIXTURE.comparativePeriods[0].restatementReason).toBeTruthy();
  });

  it("still produces zero FAILs despite the restatement — a restatement is not itself a defect", () => {
    const ctx = buildRuleContext(IFRS_FOR_SMES_FIXTURE, ZERO_TOLERANCE);
    const findings = runCanonicalRulePackV1(ctx);
    expect(findings.filter((f) => f.outcome === "FAIL")).toEqual([]);
  });
});

describe("defective fixture — every one of the ten rules fires a real, non-PASS outcome", () => {
  const ctx = buildRuleContext(DEFECTIVE_FIXTURE, ZERO_TOLERANCE);
  const findings = runCanonicalRulePackV1(ctx);
  const grouped = byRule(findings);

  it("is still a valid aggregate — every one of its defects is a business-rule violation, not a structural one", () => {
    expect(() => validateCanonicalReport(DEFECTIVE_FIXTURE)).not.toThrow();
  });

  it("runs all ten rules", () => {
    expect(grouped.size).toBe(10);
  });

  it("SFP equation is INSUFFICIENT_EVIDENCE — the duplicate total_assets concept (defect 8a) makes the anchor itself ambiguous, so the equation is honestly unevaluable rather than silently evaluated against the first match", () => {
    const sfpFindings = grouped.get("sfp-equation") ?? [];
    expect(sfpFindings.some((f) => f.outcome === "INSUFFICIENT_EVIDENCE" && f.deterministicCalculation.includes("total_assets"))).toBe(true);
    expect(sfpFindings.every((f) => f.outcome !== "FAIL")).toBe(true); // never silently picks a match to produce a FAIL either
  });

  it("subtotal casting FAILs for the total_assets line", () => {
    const castingFindings = grouped.get("subtotal-casting") ?? [];
    expect(castingFindings.some((f) => f.affected.lineId === "defect-sfp-total-assets" && f.outcome === "FAIL")).toBe(true);
  });

  it("note-to-face reconciliation FAILs for the PPE note", () => {
    expect((grouped.get("note-to-face-reconciliation") ?? []).some((f) => f.outcome === "FAIL")).toBe(true);
  });

  it("comparative-period alignment FAILs (undeclared/rogue period)", () => {
    expect((grouped.get("comparative-period-alignment") ?? []).some((f) => f.outcome === "FAIL")).toBe(true);
  });

  it("currency/scale consistency FAILs for the USD fact", () => {
    expect((grouped.get("currency-scale-consistency") ?? []).some((f) => f.outcome === "FAIL")).toBe(true);
  });

  it("cash-flow closing cash reconciliation FAILs", () => {
    expect((grouped.get("cashflow-closing-cash-reconciliation") ?? []).some((f) => f.outcome === "FAIL")).toBe(true);
  });

  it("movement reconciliation FAILs for the PPE note's own roll-forward", () => {
    expect((grouped.get("movement-reconciliation") ?? []).some((f) => f.outcome === "FAIL")).toBe(true);
  });

  it("duplicate detection FAILs for both the duplicate concept/role and the duplicate fact fingerprint", () => {
    const duplicateFindings = grouped.get("duplicate-detection") ?? [];
    const failures = duplicateFindings.filter((f) => f.outcome === "FAIL");
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it("missing comparative detection FAILs for total_assets (no comparative fact at all)", () => {
    const missingComparativeFindings = grouped.get("missing-comparative-detection") ?? [];
    expect(missingComparativeFindings.some((f) => f.affected.lineId === "defect-sfp-total-assets" && f.outcome === "FAIL")).toBe(true);
  });

  it("broken and orphaned note references both FAIL, and the valid one still PASSes", () => {
    const noteRefFindings = grouped.get("orphaned-note-reference-detection") ?? [];
    expect(noteRefFindings.filter((f) => f.outcome === "FAIL").length).toBe(2);
    expect(noteRefFindings.some((f) => f.outcome === "PASS")).toBe(true);
  });
});
