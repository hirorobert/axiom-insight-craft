/**
 * StatementRenderer — professional web-native renderer for one canonical
 * Statement, driven ONLY by canonical presentation data plus a framework
 * profile. No computation happens here: every figure is read from an
 * already-validated report's own facts; this component's job is presentation
 * (framework titles/terminology, column layout, subtotal/total weight, dash
 * policy, parenthesised negatives, statement-to-note references, print-safe
 * table semantics).
 *
 * Framework-neutral: it never branches on report.framework.kind. All wording
 * that differs between frameworks comes from the FrameworkProfile passed in.
 */
import { Fragment } from "react";
import { resolveLatestFact } from "@/lib/canonicalStatement/provenance";
import { formatMoney } from "@/lib/canonicalStatement/money";
import { CANONICAL_CONCEPTS } from "@/lib/canonicalStatement/concepts";
import type { CanonicalFinancialStatementReport, Statement, StatementLine } from "@/lib/canonicalStatement/types";
import { cn } from "@/lib/utils";
import { statementLineDomId } from "@/lib/financialStatementsWorkspace/findingsView";
import { statementTitle, type FrameworkProfile } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import type { NoteNumberingResult } from "@/lib/financialStatementsWorkspace/noteNumbering";
import { NET_RESULT_CONCEPT } from "@/lib/financialStatementsWorkspace/trialBalanceAdapter";

function periodLabel(report: CanonicalFinancialStatementReport, periodId: string, profile: FrameworkProfile): string {
  if (periodId === report.period.periodId) return `${report.period.periodYear}`;
  const comparative = report.comparativePeriods.find((p) => p.periodId === periodId);
  return comparative ? `${comparative.periodYear}${comparative.isRestated ? " (restated)" : ""}` : `${periodId} (${profile.terminology.currentPeriodLabel})`;
}

function orderedPeriodIds(report: CanonicalFinancialStatementReport): string[] {
  return [report.period.periodId, ...report.comparativePeriods.map((p) => p.periodId)];
}

/** Dash policy: a MISSING value (null fact or no binding for the period) renders "—", never a fabricated 0. A reported zero renders as 0.00. */
function renderCell(report: CanonicalFinancialStatementReport, line: StatementLine, periodId: string): string {
  const binding = line.factBindings.find((b) => b.periodId === periodId);
  if (!binding) return "—";
  const fact = resolveLatestFact(report.facts, binding.factId);
  if (!fact || fact.value === null) return "—";
  const formatted = formatMoney(fact.value);
  return formatted.startsWith("-") ? `(${formatted.slice(1)})` : formatted;
}

function labelFor(line: StatementLine, profile: FrameworkProfile): string {
  switch (line.concept) {
    case NET_RESULT_CONCEPT:
      return profile.terminology.netResult;
    case CANONICAL_CONCEPTS.TOTAL_EQUITY:
      return profile.terminology.totalEquity;
    case CANONICAL_CONCEPTS.TOTAL_LIABILITIES_AND_EQUITY:
      return profile.terminology.totalLiabilitiesAndEquity;
    default:
      return line.label;
  }
}

function sectionLabelFor(sectionId: string, label: string, profile: FrameworkProfile): string {
  if (sectionId.endsWith(":equity")) return profile.terminology.equity;
  if (sectionId.endsWith(":result")) return "Result";
  return label;
}

interface RowProps {
  readonly report: CanonicalFinancialStatementReport;
  readonly line: StatementLine;
  readonly depth: number;
  readonly profile: FrameworkProfile;
  readonly noteNumbers: readonly string[];
  readonly showNotes: boolean;
}

function LineRow({ report, line, depth, profile, noteNumbers, showNotes }: RowProps) {
  const isTotalish = line.role === "SUBTOTAL" || line.role === "TOTAL";
  const isResult = line.concept === NET_RESULT_CONCEPT;
  return (
    <tr id={statementLineDomId(line.lineId)} className={cn((isTotalish || isResult) && "border-t border-border font-semibold", line.role === "TOTAL" && "border-b-2 border-double border-foreground/40", "scroll-mt-24 transition-colors")}>
      <td className={cn("py-1.5 pr-4 text-sm text-foreground", depth > 0 && "pl-6")}>{labelFor(line, profile)}</td>
      {showNotes && <td className="py-1.5 px-2 text-center text-xs text-muted-foreground whitespace-nowrap">{noteNumbers.join(", ")}</td>}
      {orderedPeriodIds(report).map((periodId) => (
        <td key={periodId} className="py-1.5 pl-4 text-right text-sm tabular-nums text-foreground whitespace-nowrap">
          {renderCell(report, line, periodId)}
        </td>
      ))}
    </tr>
  );
}

export interface StatementRendererProps {
  readonly report: CanonicalFinancialStatementReport;
  readonly statement: Statement;
  readonly profile: FrameworkProfile;
  readonly numbering: NoteNumberingResult | null;
  /** True for every statement after the first, so a printed statement starts on its own page. */
  readonly startOnNewPage?: boolean;
}

export function StatementRenderer({ report, statement, profile, numbering, startOnNewPage }: StatementRendererProps) {
  const periods = orderedPeriodIds(report);
  const lineIds = statement.sections.flatMap((s) => s.lines.map((l) => l.lineId));
  const showNotes = !!numbering && lineIds.some((id) => (numbering.noteNumbersByLineId.get(id)?.length ?? 0) > 0);
  const title = statementTitle(profile, statement.type, statement.title);
  const columns = periods.length + 1 + (showNotes ? 1 : 0);
  return (
    <section className={cn("break-inside-avoid-page", startOnNewPage && "print:break-before-page")} aria-labelledby={`statement-${statement.statementId}`} data-statement-type={statement.type}>
      <h3 id={`statement-${statement.statementId}`} className="text-base font-semibold text-foreground mb-1">
        {title}
      </h3>
      <p className="text-xs text-muted-foreground mb-3">
        {report.entity.legalName} · {report.period.startDate} to {report.period.endDate} · {report.presentationCurrency.currency}
        {report.presentationCurrency.presentationMultiplier !== 1n ? ` ×${report.presentationCurrency.presentationMultiplier}` : ""}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] border-collapse">
          <thead className="table-header-group">
            <tr className="border-b border-border">
              <th scope="col" className="py-1.5 pr-4 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span className="sr-only">Line item</span>
              </th>
              {showNotes && (
                <th scope="col" className="py-1.5 px-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Note
                </th>
              )}
              {periods.map((periodId) => (
                <th key={periodId} scope="col" className="py-1.5 pl-4 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                  {periodLabel(report, periodId, profile)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {statement.sections.map((section) => (
              <Fragment key={section.sectionId}>
                <tr>
                  <td colSpan={columns} className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {sectionLabelFor(section.sectionId, section.label, profile)}
                  </td>
                </tr>
                {section.lines.map((line) => (
                  <LineRow key={line.lineId} report={report} line={line} depth={line.role === "DETAIL" && line.concept !== NET_RESULT_CONCEPT ? 1 : 0} profile={profile} noteNumbers={numbering?.noteNumbersByLineId.get(line.lineId) ?? []} showNotes={showNotes} />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
