// financialStatementsWorkspace/reportingPeriod.ts — explicit reporting-period
// bounds. periodYear always comes from the route and is never defaulted.
// The bounds come from the company's fiscal year end when it is set; when it
// is not, calendar-year bounds are returned but flagged as ASSUMED so the
// workspace can require confirmation instead of silently defaulting.

export type PeriodBasis = "FISCAL_YEAR_END" | "CALENDAR_YEAR_ASSUMED";

export interface ReportingPeriodBounds {
  readonly startDate: string;
  readonly endDate: string;
  readonly basis: PeriodBasis;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function deriveReportingPeriod(periodYear: number, fiscalYearEnd: string | null | undefined): ReportingPeriodBounds {
  const fye = fiscalYearEnd ? new Date(fiscalYearEnd) : null;
  if (!fye || Number.isNaN(fye.getTime())) {
    return { startDate: `${periodYear}-01-01`, endDate: `${periodYear}-12-31`, basis: "CALENDAR_YEAR_ASSUMED" };
  }
  const month = fye.getUTCMonth();
  const day = fye.getUTCDate();
  // Last day of the month for the year-end (handles 29 Feb / 28 Feb consistently for a given year).
  const end = new Date(Date.UTC(periodYear, month, day));
  if (end.getUTCMonth() !== month) {
    // Day overflowed (e.g. 29 Feb in a non-leap year) — clamp to the month's last day.
    end.setTime(Date.UTC(periodYear, month + 1, 0));
  }
  const prevEnd = new Date(Date.UTC(periodYear - 1, month, day));
  if (prevEnd.getUTCMonth() !== month) prevEnd.setTime(Date.UTC(periodYear - 1, month + 1, 0));
  const start = new Date(prevEnd.getTime() + 24 * 60 * 60 * 1000);
  return { startDate: isoDate(start), endDate: isoDate(end), basis: "FISCAL_YEAR_END" };
}
