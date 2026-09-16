// canonicalStatement/rules/shared.ts — small helpers shared by every rule
// in the first rule pack. Centralized so each rule file stays focused on
// its own accounting relationship instead of re-deriving fact/line lookup.

import type { CanonicalFinancialStatementReport, MonetaryFact, NoteReference, Statement, StatementLine, StatementType } from "../types";
import type { Money } from "../money";
import type { RuleContext } from "./ruleEngine";

export type ResolvedFact =
  | { readonly status: "PRESENT"; readonly money: Money; readonly fact: MonetaryFact }
  | { readonly status: "MISSING_VALUE"; readonly fact: MonetaryFact }
  | { readonly status: "NOT_FOUND" };

/** Resolves a factId to its latest version's value, distinguishing "no such fact" from "fact exists but value is null (MISSING)." Never coerces either case to a zero Money. */
export function resolveFact(ctx: RuleContext, factId: string | null | undefined): ResolvedFact {
  if (!factId) return { status: "NOT_FOUND" };
  const fact = ctx.latestFacts.get(factId);
  if (!fact) return { status: "NOT_FOUND" };
  if (fact.value === null) return { status: "MISSING_VALUE", fact };
  return { status: "PRESENT", money: fact.value, fact };
}

/** The factId a line is bound to for a given periodId, or undefined if the line carries no binding for that period. A line may be bound to any number of periods — never assume exactly one comparative. */
export function factIdForPeriod(line: StatementLine, periodId: string): string | undefined {
  return line.factBindings.find((binding) => binding.periodId === periodId)?.factId;
}

export function resolveFactForPeriod(ctx: RuleContext, line: StatementLine, periodId: string): ResolvedFact {
  return resolveFact(ctx, factIdForPeriod(line, periodId));
}

/** Every distinct periodId this report expects rule evaluation to consider: the current period plus every declared comparative — never just "current + one comparative." */
export function allPeriodIds(report: CanonicalFinancialStatementReport): readonly string[] {
  return [report.period.periodId, ...report.comparativePeriods.map((p) => p.periodId)];
}

export function statementsOfType(report: CanonicalFinancialStatementReport, type: StatementType): readonly Statement[] {
  return report.statements.filter((statement) => statement.type === type);
}

export function allLines(statement: Statement): readonly StatementLine[] {
  return statement.sections.flatMap((section) => section.lines);
}

export function findLineByConcept(statement: Statement, concept: string): StatementLine | undefined {
  return allLines(statement).find((line) => line.concept === concept);
}

export function findLinesByConcept(statement: Statement, concept: string): readonly StatementLine[] {
  return allLines(statement).filter((line) => line.concept === concept);
}

export function findLineById(report: CanonicalFinancialStatementReport, lineId: string): StatementLine | undefined {
  for (const statement of report.statements) {
    const found = allLines(statement).find((line) => line.lineId === lineId);
    if (found) return found;
  }
  return undefined;
}

export function statementContainingLine(
  report: CanonicalFinancialStatementReport,
  lineId: string,
): Statement | undefined {
  return report.statements.find((statement) => allLines(statement).some((line) => line.lineId === lineId));
}

/**
 * The sole correct way to ask "which note references does this line carry?"
 * — `report.noteReferences` is the single source of truth for this edge;
 * `StatementLine` does not (and must not again) carry its own
 * `noteReferenceIds` list. See NoteReference's doc comment in types.ts.
 */
export function noteReferencesForLine(report: CanonicalFinancialStatementReport, lineId: string): readonly NoteReference[] {
  return report.noteReferences.filter((ref) => ref.fromLineId === lineId);
}
