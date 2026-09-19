// financialGeneration/budgetActual.ts — the budget-versus-actual comparison.
//
// It is NOT a canonical statement type (the canonical model has none); it is a
// supplementary, workspace-level table built from two authorities that already
// exist: the approved budget (validated evidence) and the ACTUAL figures already
// on the canonical statements. Nothing here restates an actual.
//
// Semantics, all explicit:
//   variance          = actual − comparison budget           (exact, minor units)
//   comparison budget = final budget where supplied, otherwise original budget,
//                       and the basis used is always shown
//   variance %        = variance ÷ |comparison budget| × 100, rounded HALF-UP to
//                       one decimal place; null when the budget is zero
//   direction         = revenue: actual above budget is favourable;
//                       expense: actual below budget is favourable;
//                       every other nature: no favourable/adverse judgement
//   explanation       = ONLY text the preparer supplied — never generated
// A budget line with no matching actual line is reported as such: the actual is
// never assumed zero. A budget line key matches an actual by canonical lineId or
// concept, and only when that match is unique.

import { subtractMoney, type Money } from "@/lib/canonicalStatement/money";
import type { CanonicalFinancialStatementReport, StatementLine } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { amountOf, columnReader, type GenerationDiagnostic } from "./common";

export type VarianceDirection = "FAVOURABLE" | "ADVERSE" | "NONE" | "NOT_JUDGED";
export type ComparisonBasis = "FINAL_BUDGET" | "ORIGINAL_BUDGET";

export interface BudgetActualLine {
  readonly lineKey: string;
  readonly label: string;
  readonly nature: string;
  readonly comparisonBasis: ComparisonBasis;
  readonly originalBudget: Money;
  readonly finalBudget: Money | null;
  readonly budget: Money;
  /** null = no unique matching actual line on the statements (never zero). */
  readonly actual: Money | null;
  readonly actualLineId: string | null;
  readonly actualFactId: string | null;
  readonly variance: Money | null;
  /** e.g. "-12.5"; null when the variance is not computable or the budget is zero. */
  readonly variancePercent: string | null;
  readonly direction: VarianceDirection;
  readonly preparerExplanation: string | null;
  /** null = no materiality threshold was supplied, so it is not determined whether an explanation is required. */
  readonly explanationRequired: boolean | null;
  readonly evidenceRow: number;
  readonly notes: readonly string[];
}

export interface BudgetActualComparison {
  readonly status: "GENERATED";
  readonly lines: readonly BudgetActualLine[];
  readonly diagnostics: readonly GenerationDiagnostic[];
  readonly evidenceBatchId: string;
}

export interface BudgetActualOptions {
  /** Materiality as a percentage string of the budget, e.g. "10". Supplied by the preparer; never defaulted. */
  readonly materialityPercent?: string;
}

/** Round-half-up (away from zero on ties) of numerator/denominator to one decimal place, returned as a decimal string. */
export function percentOneDecimal(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  const neg = numerator < 0n !== denominator < 0n && numerator !== 0n;
  const n = (numerator < 0n ? -numerator : numerator) * 1000n; // ×100 for percent, ×10 for one decimal
  const d = denominator < 0n ? -denominator : denominator;
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  const whole = q / 10n;
  const frac = q % 10n;
  return `${neg && q !== 0n ? "-" : ""}${whole}.${frac}`;
}

function findActual(report: CanonicalFinancialStatementReport, lineKey: string): { line: StatementLine; factId: string } | "NONE" | "AMBIGUOUS" {
  const matches: StatementLine[] = [];
  for (const st of report.statements) {
    if (st.type !== "STATEMENT_OF_FINANCIAL_POSITION" && st.type !== "STATEMENT_OF_PROFIT_OR_LOSS") continue;
    for (const sec of st.sections) for (const l of sec.lines) if (l.lineId === lineKey || l.concept === lineKey) matches.push(l);
  }
  if (matches.length === 0) return "NONE";
  if (matches.length > 1) return "AMBIGUOUS";
  const fid = matches[0].factBindings.find((b) => b.periodId === report.period.periodId)?.factId;
  return fid ? { line: matches[0], factId: fid } : "NONE";
}

export function buildBudgetActual(report: CanonicalFinancialStatementReport, budget: EvidenceBatch, options: BudgetActualOptions = {}): BudgetActualComparison | { status: "EVIDENCE_GAP"; reasons: readonly string[] } {
  if (budget.currency !== report.presentationCurrency.currency || budget.scale !== report.presentationCurrency.scale) {
    return { status: "EVIDENCE_GAP", reasons: [`The budget is stated in ${budget.currency} at scale ${budget.scale}, but the statements are presented in ${report.presentationCurrency.currency} at scale ${report.presentationCurrency.scale}. No conversion is performed.`] };
  }
  const latest = new Map(report.facts.map((f) => [f.factId, f]));
  const read = columnReader(budget);
  const diagnostics: GenerationDiagnostic[] = [];
  const lines: BudgetActualLine[] = [];

  if (options.materialityPercent === undefined) {
    diagnostics.push({ code: "MATERIALITY_THRESHOLD_NOT_SET", severity: "INFO", message: "No materiality threshold was supplied, so whether each variance requires an explanation is not determined." });
  }

  for (let row = 1; row <= budget.document.rows.length; row++) {
    const lineKey = read(row, "line_key");
    const nature = read(row, "nature");
    const originalBudget = amountOf(budget, read(row, "original_budget"));
    const finalText = read(row, "final_budget");
    const finalBudget = finalText === "" ? null : amountOf(budget, finalText);
    const comparison = finalBudget ?? originalBudget;
    const notes: string[] = [];

    const match = findActual(report, lineKey);
    let actual: Money | null = null;
    let actualLineId: string | null = null;
    let actualFactId: string | null = null;
    if (match === "AMBIGUOUS") notes.push("More than one statement line matches this budget line key; no actual is assumed.");
    else if (match === "NONE") notes.push("No statement line matches this budget line key for the current period; no actual is assumed.");
    else {
      const fact = latest.get(match.factId);
      // The latest version of the fact is authoritative — the ledger is append-only, so take the highest version.
      const highest = report.facts.filter((f) => f.factId === match.factId).reduce((a, b) => (b.version > a.version ? b : a), fact!);
      if (highest?.value) {
        actual = highest.value;
        actualLineId = match.line.lineId;
        actualFactId = highest.factId;
      } else notes.push("The matching statement line has no value for the current period.");
    }

    const variance = actual ? subtractMoney(actual, comparison) : null;
    const variancePercent = variance ? percentOneDecimal(variance.minorUnits, comparison.minorUnits) : null;
    if (variance && variancePercent === null) notes.push("The budget is zero, so a percentage variance is not defined.");

    let direction: VarianceDirection = "NOT_JUDGED";
    if (variance) {
      if (variance.minorUnits === 0n) direction = "NONE";
      else if (nature === "REVENUE") direction = variance.minorUnits > 0n ? "FAVOURABLE" : "ADVERSE";
      else if (nature === "EXPENSE") direction = variance.minorUnits < 0n ? "FAVOURABLE" : "ADVERSE";
    }

    let explanationRequired: boolean | null = null;
    if (options.materialityPercent !== undefined && variance) {
      const pct = percentOneDecimal(variance.minorUnits, comparison.minorUnits);
      if (pct === null) explanationRequired = variance.minorUnits !== 0n;
      else explanationRequired = Math.abs(Number(pct)) >= Number(options.materialityPercent); // comparison of a display percentage only; no money passes through a float
    }

    const explanation = read(row, "explanation");
    lines.push({
      lineKey,
      label: read(row, "line_label"),
      nature,
      comparisonBasis: finalBudget ? "FINAL_BUDGET" : "ORIGINAL_BUDGET",
      originalBudget,
      finalBudget,
      budget: comparison,
      actual,
      actualLineId,
      actualFactId,
      variance,
      variancePercent,
      direction,
      preparerExplanation: explanation === "" ? null : explanation,
      explanationRequired,
      evidenceRow: row,
      notes,
    });
    if (explanationRequired === true && explanation === "") {
      diagnostics.push({ code: "EXPLANATION_REQUIRED_MISSING", severity: "WARNING", message: `${lineKey}: the variance meets the materiality threshold and no explanation was supplied. None is generated.` });
    }
  }
  return { status: "GENERATED", lines, diagnostics, evidenceBatchId: budget.evidenceBatchId };
}
