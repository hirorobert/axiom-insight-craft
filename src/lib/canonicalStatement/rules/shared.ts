// canonicalStatement/rules/shared.ts — small helpers shared by every rule
// in the first rule pack. Centralized so each rule file stays focused on
// its own accounting relationship instead of re-deriving fact/line lookup.

import type { CanonicalFinancialStatementReport, MonetaryFact, Statement, StatementLine, StatementType } from "../types";
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
