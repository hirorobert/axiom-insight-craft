/**
 * reportingPeriod — the confirmation card's period choice (Phase 2 §5.5 b): presets with defined date arithmetic, a
 * custom range, and the words the card shows. Pure; dates are ISO calendar dates (YYYY-MM-DD), never times or zones.
 *
 *   Year / Quarter / Month: the user gives the period END; the START is derived and shown read-only.
 *     · An end on the last day of a month covers whole months: Year ending 30 Jun 2026 → 1 Jul 2025 – 30 Jun 2026;
 *       Quarter ending 31 Mar 2026 → 1 Jan 2026 – 31 Mar 2026; Month ending 30 Apr 2026 → 1 Apr 2026 – 30 Apr 2026.
 *     · Any other end runs back N months to the day after: Year ending 15 Jun 2026 → 16 Jun 2025 – 15 Jun 2026
 *       (a shorter month clamps to its last day first).
 *   Custom: both dates are the user's.
 *
 * No silent defaults: with no evidence every field starts empty, and nothing here guesses a year end. The server
 * (open_engagement_with_period) remains the authority and enforces the same limits.
 */

export type PeriodPreset = "year" | "quarter" | "month" | "custom";

export interface PeriodChoice {
  preset: PeriodPreset | null;
  /** The period end (all presets). */
  end: string | null;
  /** Custom only. */
  start: string | null;
}

export const EMPTY_PERIOD: PeriodChoice = Object.freeze({ preset: null, end: null, start: null });
/** Mirrors public.reporting_period_max_months() (a technical data-entry ceiling, not an accounting rule). */
export const MAX_PERIOD_MONTHS = 36;
const MONTHS: Record<Exclude<PeriodPreset, "custom">, number> = { year: 12, quarter: 3, month: 1 };
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Ymd { y: number; m: number; d: number } // m is 1–12

function parse(iso: string | null | undefined): Ymd | null {
  const r = iso ? ISO.exec(iso) : null;
  if (!r) return null;
  const y = Number(r[1]), m = Number(r[2]), d = Number(r[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return { y, m, d };
}
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = ({ y, m, d }: Ymd) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function addMonths({ y, m, d }: Ymd, n: number): Ymd {
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return { y: ny, m: nm, d: Math.min(d, daysIn(ny, nm)) };
}
function addDays(a: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(a.y, a.m - 1, a.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const cmp = (a: Ymd, b: Ymd) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
const isMonthEnd = (a: Ymd) => a.d === daysIn(a.y, a.m);

/** The derived period, or null while it is incomplete or invalid. */
export function derivePeriod(c: PeriodChoice): { start: string; end: string } | null {
  const end = parse(c.end);
  if (!end || !c.preset) return null;
  if (c.preset === "custom") {
    const start = parse(c.start);
    return start ? { start: iso(start), end: iso(end) } : null;
  }
  const n = MONTHS[c.preset];
  const start = isMonthEnd(end)
    ? { ...addMonths({ y: end.y, m: end.m, d: 1 }, -(n - 1)), d: 1 }
    : addDays(addMonths(end, -n), 1);
  return { start: iso(start), end: iso(end) };
}

/** Why the choice cannot be used yet, in words; null when it can. */
export function periodProblem(c: PeriodChoice): string | null {
  if (!c.preset) return "Choose the period.";
  if (!parse(c.end)) return "Enter the date the period ends.";
  if (c.preset === "custom" && !parse(c.start)) return "Enter the date the period starts.";
  const p = derivePeriod(c);
  if (!p) return "Enter valid dates.";
  const s = parse(p.start)!, e = parse(p.end)!;
  if (cmp(s, e) > 0) return "The period starts after it ends.";
  if (cmp(e, addMonths(s, MAX_PERIOD_MONTHS)) >= 0) return `A single period can't be longer than ${MAX_PERIOD_MONTHS} months.`;
  if (e.y < 2000 || e.y > 2100) return "The period must end between 2000 and 2100.";
  return null;
}

const short = (a: Ymd) => `${a.d} ${MONTH_NAMES[a.m - 1].slice(0, 3)} ${a.y}`;
const long = (a: Ymd) => `${a.d} ${MONTH_NAMES[a.m - 1]} ${a.y}`;

/** "1 Jul 2025 – 30 Jun 2026". */
export function periodRange(p: { start: string; end: string }): string {
  return `${short(parse(p.start)!)} – ${short(parse(p.end)!)}`;
}

/** The period's name: "Year ended 30 June 2026", "Quarter ended …", "Month ended …", or the range for anything else. */
export function periodName(c: PeriodChoice): string | null {
  const p = derivePeriod(c);
  if (!p) return null;
  const end = parse(p.end)!;
  if (c.preset === "year" || c.preset === "quarter" || c.preset === "month") {
    const word = { year: "Year", quarter: "Quarter", month: "Month" }[c.preset];
    return `${word} ended ${long(end)}`;
  }
  return periodRange(p);
}

/** The reporting year the workspace route uses (the year the period ends) — the same rule as the server. */
export function periodYear(c: PeriodChoice): number | null {
  const p = derivePeriod(c);
  return p ? parse(p.end)!.y : null;
}

/**
 * A suggestion only (never pre-selected): the year that follows a confirmed period, offered when that period was itself
 * a year by the same arithmetic. Anything else (a quarter, a 15-month period) has no automatic successor.
 */
export function followingYear(prev: { start: string; end: string }): PeriodChoice | null {
  const end = parse(prev.end);
  if (!end) return null;
  const asYear = derivePeriod({ preset: "year", end: prev.end, start: null });
  if (!asYear || asYear.start !== prev.start) return null;
  const next = isMonthEnd(end) ? { y: end.y + 1, m: end.m, d: daysIn(end.y + 1, end.m) } : addMonths(end, 12);
  return { preset: "year", end: iso(next), start: null };
}
