// Rule 1 — Statement of financial position equation: assets = liabilities + equity.
// Evaluated once per period — the report's current period AND every
// declared comparative period, however many there are (never assumed to be
// exactly one). NOT_APPLICABLE when the report has no SFP at all (e.g. an
// IPSAS cash-basis entity, whose primary statement is cash receipts and
// payments) — this is an honest structural absence, not a failure.

import { addMoney, equalsWithinTolerance, formatMoney } from "../money";
import { CANONICAL_CONCEPTS } from "../concepts";
import { allPeriodIds, findLineByConcept, resolveFactForPeriod, statementsOfType } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "sfp-equation";
export const RULE_VERSION = "1.0.0";

function evaluateForPeriod(
  ctx: RuleContext,
  statementId: string,
  assetsLine: ReturnType<typeof findLineByConcept>,
  liabilitiesLine: ReturnType<typeof findLineByConcept>,
  equityLine: ReturnType<typeof findLineByConcept>,
  liabilitiesAndEquityLine: ReturnType<typeof findLineByConcept>,
  periodId: string,
): RuleEvaluationResult {
  const discriminator = `${statementId}:${periodId}`;
  const assets = resolveFactForPeriod(ctx, assetsLine!, periodId);
  const liabilities = resolveFactForPeriod(ctx, liabilitiesLine!, periodId);
  const equity = resolveFactForPeriod(ctx, equityLine!, periodId);

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
      { evidenceReferenceId: `${discriminator}:assets`, lineId: assetsLine!.lineId, statementId },
      { evidenceReferenceId: `${discriminator}:liabilities`, lineId: liabilitiesLine!.lineId, statementId },
      { evidenceReferenceId: `${discriminator}:equity`, lineId: equityLine!.lineId, statementId },
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
      const assetsLine = findLineByConcept(statement, CANONICAL_CONCEPTS.TOTAL_ASSETS);
      const liabilitiesLine = findLineByConcept(statement, CANONICAL_CONCEPTS.TOTAL_LIABILITIES);
      const equityLine = findLineByConcept(statement, CANONICAL_CONCEPTS.TOTAL_EQUITY);
      const liabilitiesAndEquityLine = findLineByConcept(statement, CANONICAL_CONCEPTS.TOTAL_LIABILITIES_AND_EQUITY);
      if (!assetsLine || !liabilitiesLine || !equityLine) continue;

      for (const periodId of allPeriodIds(ctx.report)) {
        const hasAnyBinding =
          assetsLine.factBindings.some((b) => b.periodId === periodId) ||
          liabilitiesLine.factBindings.some((b) => b.periodId === periodId) ||
          equityLine.factBindings.some((b) => b.periodId === periodId);
        if (!hasAnyBinding) continue;
        results.push(evaluateForPeriod(ctx, statement.statementId, assetsLine, liabilitiesLine, equityLine, liabilitiesAndEquityLine, periodId));
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
