/**
 * StatementRenderer — Phase 5: professional web-native renderer for one
 * canonical Statement, driven ONLY by canonical presentation data
 * (CanonicalFinancialStatementReport). No computation happens here — every
 * figure is read from an already-validated report's own facts; this
 * component's only job is presentation (column layout, subtotal/total
 * weight, dash policy, negative-value parentheses, print-safe table
 * semantics).
 *
 * Framework-neutral: it never branches on report.framework.kind. Any
 * future IFRS/IPSAS-specific terminology belongs in a presentation
 * profile this component reads, not in an if/else here (mission
 * requirement — no framework-specific presentation hard-coded into a
 * generic component).
 */
import { Fragment } from "react";
import { resolveLatestFact } from "@/lib/canonicalStatement/provenance";
import { formatMoney } from "@/lib/canonicalStatement/money";
import type { CanonicalFinancialStatementReport, Statement, StatementLine } from "@/lib/canonicalStatement/types";
import { cn } from "@/lib/utils";
import { statementLineDomId } from "@/lib/financialStatementsWorkspace/findingsView";

function periodLabel(report: CanonicalFinancialStatementReport, periodId: string): string {
  if (periodId === report.period.periodId) return `${report.period.periodYear}`;
  const comparative = report.comparativePeriods.find((p) => p.periodId === periodId);
  return comparative ? `${comparative.periodYear}${comparative.isRestated ? " (restated)" : ""}` : periodId;
}

function orderedPeriodIds(report: CanonicalFinancialStatementReport): string[] {
  return [report.period.periodId, ...report.comparativePeriods.map((p) => p.periodId)];
}

/** Dash policy: a MISSING fact (value === null, or no binding for this period) renders "—", never a fabricated 0. A genuine reported zero renders "0". */
function renderCell(report: CanonicalFinancialStatementReport, line: StatementLine, periodId: string): string {
  const binding = line.factBindings.find((b) => b.periodId === periodId);
  if (!binding) return "—";
  const fact = resolveLatestFact(report.facts, binding.factId);
  if (!fact || fact.value === null) return "—";
  const formatted = formatMoney(fact.value);
  return formatted.startsWith("-") ? `(${formatted.slice(1)})` : formatted;
}

function LineRow({ report, line, depth }: { report: CanonicalFinancialStatementReport; line: StatementLine; depth: number }) {
  const isTotalish = line.role === "SUBTOTAL" || line.role === "TOTAL";
  return (
    <tr id={statementLineDomId(line.lineId)} className={cn(isTotalish && "border-t border-border font-semibold", line.role === "TOTAL" && "border-b-2 border-double border-foreground/40", "scroll-mt-24 transition-colors")}>
      <td className={cn("py-1.5 pr-4 text-sm text-foreground", depth > 0 && "pl-6")}>{line.label}</td>
      {orderedPeriodIds(report).map((periodId) => (
        <td key={periodId} className="py-1.5 pl-4 text-right text-sm tabular-nums text-foreground whitespace-nowrap">
          {renderCell(report, line, periodId)}
        </td>
      ))}
    </tr>
  );
}

export function StatementRenderer({ report, statement }: { report: CanonicalFinancialStatementReport; statement: Statement }) {
  const periods = orderedPeriodIds(report);
  return (
    <section className="break-inside-avoid-page" aria-labelledby={`statement-${statement.statementId}`}>
      <h3 id={`statement-${statement.statementId}`} className="text-base font-semibold text-foreground mb-1">
        {statement.title}
      </h3>
      <p className="text-xs text-muted-foreground mb-3">
        {report.entity.legalName} · {report.presentationCurrency.currency}
        {report.presentationCurrency.presentationMultiplier !== 1n ? ` '000s ×${report.presentationCurrency.presentationMultiplier}` : ""}
      </p>
      <table className="w-full border-collapse">
        <thead className="table-header-group">
          <tr className="border-b border-border">
            <th scope="col" className="py-1.5 pr-4 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              &nbsp;
            </th>
            {periods.map((periodId) => (
              <th key={periodId} scope="col" className="py-1.5 pl-4 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                {periodLabel(report, periodId)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {statement.sections.map((section) => (
            <Fragment key={section.sectionId}>
              <tr>
                <td colSpan={periods.length + 1} className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.label}
                </td>
              </tr>
              {section.lines.map((line) => (
                <LineRow key={line.lineId} report={report} line={line} depth={line.role === "DETAIL" ? 1 : 0} />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
