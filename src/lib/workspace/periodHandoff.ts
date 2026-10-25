/** Saved period identity only. File names and browser state never choose a reporting year. */
export interface SavedPeriodRow {
  id: string;
  reporting_start: string | null;
  reporting_end: string | null;
  fiscal_year_end?: string;
  reporting_currency: string | null;
  prior_period_id: string | null;
}
export interface SavedPeriod { id: string; start: string; end: string; currency: string; year: number }
export interface PeriodHandoff { current: SavedPeriod; prior: SavedPeriod | null; following: SavedPeriod | null }

function period(row: SavedPeriodRow): SavedPeriod {
  const start = row.reporting_start?.slice(0, 10), end = row.reporting_end?.slice(0, 10);
  const valid = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(start) || !valid(end) || start > end || !/^[A-Z]{3}$/.test(row.reporting_currency ?? "")) throw Error("Saved period details are incomplete.");
  const year = Number(end.slice(0, 4));
  if (year < 2000 || year > 2100) throw Error("Saved period year is outside the supported range.");
  return { id: row.id, start, end, currency: row.reporting_currency!, year };
}

export function resolvePeriodHandoff(rows: SavedPeriodRow[], year: number): PeriodHandoff | null {
  const candidates = rows.filter((r) => Number((r.reporting_end ?? r.fiscal_year_end ?? "").slice(0, 4)) === year);
  if (candidates.length > 1) throw Error("The reporting year is ambiguous.");
  const row = candidates[0];
  if (!row) return null;
  const current = period(row);
  let prior: SavedPeriod | null = null;
  if (row.prior_period_id) {
    const matches = rows.filter((r) => r.id === row.prior_period_id);
    if (matches.length !== 1 || row.prior_period_id === row.id) throw Error("The linked prior period could not be read.");
    prior = period(matches[0]);
    if (Date.parse(current.start) - Date.parse(prior.end) !== 86_400_000 || prior.year === current.year) throw Error("The linked reporting periods are not adjacent supported years.");
  }
  const next = rows.filter((r) => r.prior_period_id === row.id);
  // Do not guess a destination when more than one period refers to this year.
  const following = next.length === 1 ? period(next[0]) : null;
  return { current, prior, following: following && Date.parse(following.start) - Date.parse(current.end) === 86_400_000 && following.year !== current.year ? following : null };
}
