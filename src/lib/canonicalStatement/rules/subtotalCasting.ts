// Rule 2 — statement subtotal and total casting: every SUBTOTAL/TOTAL
// line's value must equal the sum of the sibling lines it declares in
// `castingChildLineIds`, evaluated independently for every period the line
// carries a binding for (current, and however many comparative periods are
// declared — never assumed to be exactly one). Casting bases are never
// inferred — a TOTAL/SUBTOTAL line with no declared children is
// INSUFFICIENT_EVIDENCE, not a silent PASS.

import { equalsWithinTolerance, formatMoney, sumMoney, type Money } from "../money";
import { allLines, allPeriodIds, factIdForPeriod, findLineById, resolveFact } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";
import type { Statement, StatementLine } from "../types";

export const RULE_ID = "subtotal-casting";
export const RULE_VERSION = "1.0.0";
/** V2 additionally honours a line's castingNilPeriodIds declaration (see StatementLine). V1 is unchanged byte for byte. */
export const RULE_VERSION_V2 = "1.1.0";

function evaluateLineForPeriod(
  honourNilDeclaration: boolean,
  ctx: RuleContext,
  statement: Statement,
  line: StatementLine,
  periodId: string,
): RuleEvaluationResult | null {
  if (line.role === "DETAIL") return null;
  const ownFactId = factIdForPeriod(line, periodId);
  if (!ownFactId) return null; // no binding for this period at all — Rule 9 (missing comparative) owns that gap, not this rule
  const discriminator = `${line.lineId}:${periodId}`;
  const affected = { statementId: statement.statementId, lineId: line.lineId };

  if (line.castingChildLineIds.length === 0) {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      failureSeverity: "MEDIUM",
      observedValues: {},
      expectedRelationship: `${line.concept} = sum(declared casting children)`,
      deterministicCalculation: "no casting children declared for this subtotal/total line",
      evidenceReferences: [],
      affected,
      remediationGuidance: `Declare castingChildLineIds for line "${line.lineId}" so its casting can be verified.`,
      discriminator,
      periodId,
    };
  }

  const own = resolveFact(ctx, ownFactId);
  const nilPeriod = honourNilDeclaration && (line.castingNilPeriodIds ?? []).includes(periodId);
  const allChildResolutions = line.castingChildLineIds.map((childId) => {
    const childLine = findLineById(ctx.report, childId);
    const childFactId = childLine ? factIdForPeriod(childLine, periodId) : undefined;
    return { childId, resolved: resolveFact(ctx, childFactId), unbound: childLine !== undefined && childFactId === undefined };
  });
  // A child with no binding for a period the line declares NIL contributed nothing there (e.g. an account that exists in the other
  // year only, or a restatement of the comparative, which has no current-year amount). A bound child whose fact is missing, or a
  // child that does not exist, is still missing evidence: only an explicit declaration by the line turns absence into nil.
  const childResolutions = nilPeriod ? allChildResolutions.filter((r) => !r.unbound) : allChildResolutions;

  const missing = childResolutions.filter((r) => r.resolved.status !== "PRESENT");
  if (own.status !== "PRESENT" || missing.length > 0) {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      failureSeverity: "MEDIUM",
      observedValues: {
        ownValue: { kind: "MONEY", value: own.status === "PRESENT" ? own.money : null },
        missingChildCount: { kind: "COUNT", value: missing.length },
      },
      expectedRelationship: `${line.concept} = sum(${line.castingChildLineIds.join(" + ")})`,
      deterministicCalculation: "the total's own value or one or more casting children are missing for this period",
      evidenceReferences: [],
      affected,
      remediationGuidance: "Ensure the total and every declared casting child have an extracted value for this period.",
      discriminator,
      periodId,
    };
  }

  const present = childResolutions as ReadonlyArray<{ childId: string; resolved: { status: "PRESENT"; money: Money } }>;
  let sum: Money;
  try {
    // Non-empty unless every declared child is unbound in a period the line declares nil, when the sum is exactly nil.
    sum = present.length === 0
      ? ({ currency: (own as { money: Money }).money.currency, scale: (own as { money: Money }).money.scale, minorUnits: 0n } as Money)
      : (sumMoney(present.map((r) => r.resolved.money)) as Money);
  } catch {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      failureSeverity: "MEDIUM",
      observedValues: {},
      expectedRelationship: `${line.concept} = sum(${line.castingChildLineIds.join(" + ")})`,
      deterministicCalculation: "casting children are not all the same currency/scale — cannot sum",
      evidenceReferences: [],
      affected,
      remediationGuidance: "Resolve the currency/scale mismatch among casting children before this rule can run.",
      discriminator,
      periodId,
    };
  }

  const ownMoney = (own as { money: Money }).money;
  const denominationMatches = ownMoney.currency === sum.currency && ownMoney.scale === sum.scale;
  const pass = denominationMatches && equalsWithinTolerance(ownMoney, sum, ctx.tolerance);

  return {
    outcome: denominationMatches ? (pass ? "PASS" : "FAIL") : "INSUFFICIENT_EVIDENCE",
    failureSeverity: "HIGH",
    observedValues: {
      ownValue: { kind: "MONEY", value: ownMoney },
      sumOfChildren: { kind: "MONEY", value: sum },
    },
    expectedRelationship: `${line.concept} = sum(${line.castingChildLineIds.join(" + ")})`,
    deterministicCalculation: denominationMatches
      ? `${formatMoney(ownMoney)} vs sum = ${formatMoney(sum)}`
      : "the total and the sum of its children are denominated differently — cannot compare",
    evidenceReferences: line.castingChildLineIds.map((childId) => ({ evidenceReferenceId: `${discriminator}:${childId}`, lineId: childId })),
    affected,
    remediationGuidance: pass ? "No action required." : `Recast "${line.lineId}" — its value does not equal the sum of its declared children for this period.`,
    discriminator,
    periodId,
  };
}

function makeRule(honourNilDeclaration: boolean, ruleVersion: string): RuleDefinition {
  return {
    ruleId: RULE_ID,
    ruleVersion,
    title: "Statement subtotal and total casting",
    evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
      const results: RuleEvaluationResult[] = [];
      for (const statement of ctx.report.statements) {
        for (const line of allLines(statement)) {
          for (const periodId of allPeriodIds(ctx.report)) {
            const result = evaluateLineForPeriod(honourNilDeclaration, ctx, statement, line, periodId);
            if (result) results.push(result);
          }
        }
      }
      return results;
    },
  };
}

export const subtotalCastingRule: RuleDefinition = makeRule(false, RULE_VERSION);
export const subtotalCastingRuleV2: RuleDefinition = makeRule(true, RULE_VERSION_V2);
