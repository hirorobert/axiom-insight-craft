// Rule 1 — Statement of financial position equation: assets = liabilities + equity.
// Evaluated once per period — the report's current period AND every
// declared comparative period, however many there are (never assumed to be
// exactly one). NOT_APPLICABLE when the report has no SFP at all (e.g. an
// IPSAS cash-basis entity, whose primary statement is cash receipts and
// payments) — this is an honest structural absence, not a failure.
//
// Every canonical anchor concept (total_assets, total_liabilities,
// total_equity, total_liabilities_and_equity) is resolved with explicit
// cardinality via `resolveLineByConcept` — never "first match wins." Zero
// matches for a required anchor is INSUFFICIENT_EVIDENCE (a statement
// missing an expected concept). More than one match is INSUFFICIENT_EVIDENCE
// naming every conflicting lineId — the equation cannot be safely evaluated
// while it is ambiguous WHICH line is "the" total_assets. Only Rule 8
// (duplicate-detection) has an opinion about duplicate concepts; this rule
// never silently picks one.

import { addMoney, equalsWithinTolerance, formatMoney } from "../money";
import { CANONICAL_CONCEPTS } from "../concepts";
import { allPeriodIds, resolveFactForPeriod, resolveLineByConcept, statementsOfType } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";
import type { StatementLine } from "../types";

export const RULE_ID = "sfp-equation";
export const RULE_VERSION = "1.0.0";

function ambiguousConceptResult(statementId: string, concept: string, lines: readonly StatementLine[]): RuleEvaluationResult {
  // Sorted, never in the input array's own order — the conflicting-line
  // report must be identical no matter how the statement's lines/sections
  // happened to be declared, exactly like the ambiguity determination itself.
  const lineIds = lines.map((l) => l.lineId).sort();
  return {
    outcome: "INSUFFICIENT_EVIDENCE",
    failureSeverity: "HIGH",
    observedValues: { conflictingLineIds: { kind: "TEXT", value: lineIds.join(", ") } },
    expectedRelationship: `exactly one line with concept "${concept}" per statement`,
    deterministicCalculation: `${lines.length} lines in statement "${statementId}" share concept "${concept}": ${lineIds.join(", ")}`,
    evidenceReferences: lineIds.map((lineId) => ({ evidenceReferenceId: `${statementId}:${concept}:${lineId}`, lineId, statementId })),
    affected: { statementId },
    remediationGuidance: `Resolve the ambiguity — more than one line in statement "${statementId}" declares concept "${concept}". A reviewer must merge, re-key, or remove the duplicate before this rule can evaluate the equation.`,
    discriminator: `${statementId}:${concept}:ambiguous`,
  };
}

function missingConceptsResult(statementId: string, missing: readonly string[]): RuleEvaluationResult {
  return {
    outcome: "INSUFFICIENT_EVIDENCE",
    failureSeverity: "HIGH",
    observedValues: { missingConcepts: { kind: "TEXT", value: missing.join(", ") } },
    expectedRelationship: "total_assets = total_liabilities + total_equity",
    deterministicCalculation: `statement "${statementId}" has no line for required concept(s): ${missing.join(", ")}`,
    evidenceReferences: [],
    affected: { statementId },
    remediationGuidance: `Declare the missing ${missing.join(", ")} line(s) with their canonical concept before this rule can run.`,
    discriminator: `${statementId}:missing-concepts`,
  };
}

function evaluateForPeriod(
  ctx: RuleContext,
  statementId: string,
  assetsLine: StatementLine,
  liabilitiesLine: StatementLine,
  equityLine: StatementLine,
  liabilitiesAndEquityLine: StatementLine | undefined,
  periodId: string,
): RuleEvaluationResult {
  const discriminator = `${statementId}:${periodId}`;
  const assets = resolveFactForPeriod(ctx, assetsLine, periodId);
  const liabilities = resolveFactForPeriod(ctx, liabilitiesLine, periodId);
  const equity = resolveFactForPeriod(ctx, equityLine, periodId);

  if (assets.status !== "PRESENT" || liabilities.status !== "PRESENT" || equity.status !== "PRESENT") {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      failureSeverity: "MEDIUM",
      observedValues: {
        totalAssets: { kind: "MONEY", value: assets.status === "PRESENT" ? assets.money : null },
        totalLiabilities: { kind: "MONEY", value: liabilities.status === "PRESENT" ? liabilities.money : null },
        totalEquity: { kind: "MONEY", value: equity.status === "PRESENT" ? equity.money : null },
      },
      expectedRelationship: "total_assets = total_liabilities + total_equity",
      deterministicCalculation: "one or more required totals are missing for this period — cannot evaluate",
      evidenceReferences: [],
      affected: { statementId },
      remediationGuidance: "Ensure total_assets, total_liabilities and total_equity are all extracted for this period before this rule can run.",
      discriminator,
      periodId,
    };
  }

  let rhs;
  try {
    rhs = addMoney(liabilities.money, equity.money);
  } catch {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      failureSeverity: "MEDIUM",
      observedValues: {
        totalAssets: { kind: "MONEY", value: assets.money },
        totalLiabilities: { kind: "MONEY", value: liabilities.money },
        totalEquity: { kind: "MONEY", value: equity.money },
      },
      expectedRelationship: "total_assets = total_liabilities + total_equity",
      deterministicCalculation: "total_liabilities and total_equity are denominated differently — cannot sum",
      evidenceReferences: [],
      affected: { statementId },
      remediationGuidance: "Resolve the currency/scale mismatch (see Rule currency-scale-consistency) before this rule can run.",
      discriminator,
      periodId,
    };
  }

  const denominationMatches = assets.money.currency === rhs.currency && assets.money.scale === rhs.scale;
  const pass = denominationMatches && equalsWithinTolerance(assets.money, rhs, ctx.tolerance);

  const presentedTotal = liabilitiesAndEquityLine ? resolveFactForPeriod(ctx, liabilitiesAndEquityLine, periodId) : { status: "NOT_FOUND" as const };
  const observedValues = {
    totalAssets: { kind: "MONEY" as const, value: assets.money },
    totalLiabilities: { kind: "MONEY" as const, value: liabilities.money },
    totalEquity: { kind: "MONEY" as const, value: equity.money },
    ...(presentedTotal.status === "PRESENT"
      ? { totalLiabilitiesAndEquityAsPresented: { kind: "MONEY" as const, value: presentedTotal.money } }
      : {}),
  };

  return {
    outcome: denominationMatches ? (pass ? "PASS" : "FAIL") : "INSUFFICIENT_EVIDENCE",
    failureSeverity: "CRITICAL",
    observedValues,
    expectedRelationship: "total_assets = total_liabilities + total_equity",
    deterministicCalculation: denominationMatches
      ? `${formatMoney(assets.money)} vs ${formatMoney(liabilities.money)} + ${formatMoney(equity.money)} = ${formatMoney(rhs)}`
      : "total_assets and (total_liabilities + total_equity) are denominated differently — cannot compare",
    evidenceReferences: [
      { evidenceReferenceId: `${discriminator}:assets`, lineId: assetsLine.lineId, statementId },
      { evidenceReferenceId: `${discriminator}:liabilities`, lineId: liabilitiesLine.lineId, statementId },
      { evidenceReferenceId: `${discriminator}:equity`, lineId: equityLine.lineId, statementId },
    ],
    affected: { statementId },
    remediationGuidance: pass
      ? "No action required."
      : "Investigate the discrepancy between total assets and total liabilities plus equity — one of the three totals is mis-cast or a fact is missing from this reconciliation.",
    discriminator,
    periodId,
  };
}

export const financialPositionEquationRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Statement of financial position equation",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    for (const statement of statementsOfType(ctx.report, "STATEMENT_OF_FINANCIAL_POSITION")) {
      const assetsResolution = resolveLineByConcept(statement, CANONICAL_CONCEPTS.TOTAL_ASSETS);
      const liabilitiesResolution = resolveLineByConcept(statement, CANONICAL_CONCEPTS.TOTAL_LIABILITIES);
      const equityResolution = resolveLineByConcept(statement, CANONICAL_CONCEPTS.TOTAL_EQUITY);
      const liabilitiesAndEquityResolution = resolveLineByConcept(statement, CANONICAL_CONCEPTS.TOTAL_LIABILITIES_AND_EQUITY);

      const anchors: readonly [string, typeof assetsResolution][] = [
        [CANONICAL_CONCEPTS.TOTAL_ASSETS, assetsResolution],
        [CANONICAL_CONCEPTS.TOTAL_LIABILITIES, liabilitiesResolution],
        [CANONICAL_CONCEPTS.TOTAL_EQUITY, equityResolution],
        [CANONICAL_CONCEPTS.TOTAL_LIABILITIES_AND_EQUITY, liabilitiesAndEquityResolution],
      ];
      let anyAmbiguous = false;
      for (const [concept, resolution] of anchors) {
        if (resolution.status === "AMBIGUOUS") {
          anyAmbiguous = true;
          results.push(ambiguousConceptResult(statement.statementId, concept, resolution.lines));
        }
      }
      if (anyAmbiguous) continue; // cannot safely evaluate the equation while any anchor concept is ambiguous

      const assetsLine = assetsResolution.status === "UNIQUE" ? assetsResolution.line : undefined;
      const liabilitiesLine = liabilitiesResolution.status === "UNIQUE" ? liabilitiesResolution.line : undefined;
      const equityLine = equityResolution.status === "UNIQUE" ? equityResolution.line : undefined;
      const liabilitiesAndEquityLine = liabilitiesAndEquityResolution.status === "UNIQUE" ? liabilitiesAndEquityResolution.line : undefined;

      const missing: string[] = [];
      if (!assetsLine) missing.push(CANONICAL_CONCEPTS.TOTAL_ASSETS);
      if (!liabilitiesLine) missing.push(CANONICAL_CONCEPTS.TOTAL_LIABILITIES);
      if (!equityLine) missing.push(CANONICAL_CONCEPTS.TOTAL_EQUITY);

      if (missing.length > 0) {
        results.push(missingConceptsResult(statement.statementId, missing));
        continue;
      }

      for (const periodId of allPeriodIds(ctx.report)) {
        const hasAnyBinding =
          assetsLine!.factBindings.some((b) => b.periodId === periodId) ||
          liabilitiesLine!.factBindings.some((b) => b.periodId === periodId) ||
          equityLine!.factBindings.some((b) => b.periodId === periodId);
        if (!hasAnyBinding) continue;
        results.push(evaluateForPeriod(ctx, statement.statementId, assetsLine!, liabilitiesLine!, equityLine!, liabilitiesAndEquityLine, periodId));
      }
    }
    if (results.length === 0) {
      return [
        {
          outcome: "NOT_APPLICABLE",
          failureSeverity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "total_assets = total_liabilities + total_equity",
          deterministicCalculation: "no STATEMENT_OF_FINANCIAL_POSITION is present in this report",
          evidenceReferences: [],
          affected: {},
          remediationGuidance: "No action required — this framework's primary statement is not a statement of financial position.",
          discriminator: "no-sfp",
        },
      ];
    }
    return results;
  },
};
