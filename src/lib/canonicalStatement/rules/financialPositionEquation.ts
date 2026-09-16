// Rule 1 — Statement of financial position equation: assets = liabilities + equity.
// NOT_APPLICABLE when the report has no SFP at all (e.g. an IPSAS cash-basis
// entity, whose primary statement is cash receipts and payments) — this is
// an honest structural absence, not a failure.

import { addMoney, equalsWithinTolerance, formatMoney } from "../money";
import { CANONICAL_CONCEPTS } from "../concepts";
import type { ReportingPeriodRef } from "../types";
import { findLineByConcept, resolveFact, statementsOfType } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "sfp-equation";
export const RULE_VERSION = "1.0.0";

function evaluateForPeriod(
  ctx: RuleContext,
  statementId: string,
  assetsFactId: string | null,
  liabilitiesFactId: string | null,
  equityFactId: string | null,
  liabilitiesAndEquityFactId: string | null,
  period: ReportingPeriodRef,
): RuleEvaluationResult {
  const discriminator = `${statementId}:${period.periodId}`;
  const assets = resolveFact(ctx, assetsFactId);
  const liabilities = resolveFact(ctx, liabilitiesFactId);
  const equity = resolveFact(ctx, equityFactId);

  if (assets.status !== "PRESENT" || liabilities.status !== "PRESENT" || equity.status !== "PRESENT") {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      severity: "MEDIUM",
      observedValues: {
        totalAssets: { kind: "MONEY", value: assets.status === "PRESENT" ? assets.money : null, factId: assetsFactId ?? undefined },
        totalLiabilities: { kind: "MONEY", value: liabilities.status === "PRESENT" ? liabilities.money : null, factId: liabilitiesFactId ?? undefined },
        totalEquity: { kind: "MONEY", value: equity.status === "PRESENT" ? equity.money : null, factId: equityFactId ?? undefined },
      },
      expectedRelationship: "total_assets = total_liabilities + total_equity",
      deterministicCalculation: "one or more required totals are missing — cannot evaluate",
      evidenceReferences: [],
      affected: { statementId },
      remediationGuidance: "Ensure total_assets, total_liabilities and total_equity are all extracted for this period before this rule can run.",
      discriminator,
    };
  }

  let rhs;
  try {
    rhs = addMoney(liabilities.money, equity.money);
  } catch {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      severity: "MEDIUM",
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
    };
  }

  const pass = assets.money.currency === rhs.currency && assets.money.scale === rhs.scale && equalsWithinTolerance(assets.money, rhs, ctx.tolerance);
  const denominationMatches = assets.money.currency === rhs.currency && assets.money.scale === rhs.scale;

  const presentedTotal = resolveFact(ctx, liabilitiesAndEquityFactId);
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
    severity: "CRITICAL",
    observedValues,
    expectedRelationship: "total_assets = total_liabilities + total_equity",
    deterministicCalculation: denominationMatches
      ? `${formatMoney(assets.money)} vs ${formatMoney(liabilities.money)} + ${formatMoney(equity.money)} = ${formatMoney(rhs)}`
      : "total_assets and (total_liabilities + total_equity) are denominated differently — cannot compare",
    evidenceReferences: [
      { evidenceReferenceId: `${discriminator}:assets`, factId: assetsFactId ?? undefined, statementId },
      { evidenceReferenceId: `${discriminator}:liabilities`, factId: liabilitiesFactId ?? undefined, statementId },
      { evidenceReferenceId: `${discriminator}:equity`, factId: equityFactId ?? undefined, statementId },
    ],
    affected: { statementId },
    remediationGuidance: pass
      ? "No action required."
      : "Investigate the discrepancy between total assets and total liabilities plus equity — one of the three totals is mis-cast or a fact is missing from this reconciliation.",
    discriminator,
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

      results.push(
        evaluateForPeriod(
          ctx,
          statement.statementId,
          assetsLine?.currentFactId ?? null,
          liabilitiesLine?.currentFactId ?? null,
          equityLine?.currentFactId ?? null,
          liabilitiesAndEquityLine?.currentFactId ?? null,
          { periodId: ctx.report.period.periodId, isComparative: false },
        ),
      );

      for (const comparative of ctx.report.comparativePeriods) {
        if (!assetsLine?.comparativeFactId && !liabilitiesLine?.comparativeFactId && !equityLine?.comparativeFactId) continue;
        results.push(
          evaluateForPeriod(
            ctx,
            statement.statementId,
            assetsLine?.comparativeFactId ?? null,
            liabilitiesLine?.comparativeFactId ?? null,
            equityLine?.comparativeFactId ?? null,
            liabilitiesAndEquityLine?.comparativeFactId ?? null,
            { periodId: comparative.periodId, isComparative: true },
          ),
        );
      }
    }
    if (results.length === 0) {
      return [
        {
          outcome: "NOT_APPLICABLE",
          severity: "INFORMATIONAL",
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
