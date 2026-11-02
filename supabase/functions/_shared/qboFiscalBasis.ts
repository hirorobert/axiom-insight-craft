/** Verified Preferences + saved period determine fiscal YTD; an echoed StartPeriod never proves the basis. */
export interface QboSavedPeriod {
  id: string; companyId: string; year: number; start: string; end: string; currency: string;
}
export interface QboFiscalBasis {
  kind: "fiscal-ytd-as-of"; fiscalStartMonth: number; fiscalStart: string; asOf: string;
  accountingMethod: "Accrual" | "Cash"; currency: string; preferencesSha256: string;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const realDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

export function readFiscalPreferences(payload: unknown): { month: number; method: "Accrual" | "Cash"; currency: string } | null {
  const p = object(object(payload)?.Preferences);
  const a = object(p?.AccountingInfoPrefs), r = object(p?.ReportPrefs), c = object(p?.CurrencyPrefs);
  const home = object(c?.HomeCurrency);
  const month = MONTHS.indexOf(String(a?.FirstMonthOfFiscalYear)) + 1;
  if (!month || (r?.ReportBasis !== "Accrual" && r?.ReportBasis !== "Cash") || typeof home?.value !== "string" || !/^[A-Z]{3}$/.test(home.value)) return null;
  return { month, method: r.ReportBasis, currency: home.value };
}

export function alignQboFiscalBasis(period: QboSavedPeriod, payload: unknown, preferencesSha256: string):
  { ok: true; basis: QboFiscalBasis } | { ok: false; outcome: "fiscal_configuration_missing" | "fiscal_period_mismatch" | "currency_mismatch"; message: string } {
  const prefs = readFiscalPreferences(payload);
  if (!prefs || !/^[a-f0-9]{64}$/.test(preferencesSha256)) return { ok: false, outcome: "fiscal_configuration_missing", message: "QuickBooks fiscal month, accounting basis and home currency could not be verified. Confirm these in QuickBooks, then try again." };
  if (!realDate(period.start) || !realDate(period.end) || period.start > period.end || period.year !== Number(period.end.slice(0, 4)))
    return { ok: false, outcome: "fiscal_period_mismatch", message: "Confirm this workspace's saved reporting dates before importing." };
  const year = Number(period.end.slice(0, 4)) - (Number(period.end.slice(5, 7)) < prefs.month ? 1 : 0);
  const fiscalStart = `${year}-${String(prefs.month).padStart(2, "0")}-01`;
  if (period.start !== fiscalStart) return { ok: false, outcome: "fiscal_period_mismatch", message: `QuickBooks Trial Balance is fiscal year-to-date as of ${period.end}, starting ${fiscalStart}. This workspace starts ${period.start}. Choose an aligned saved period, or upload a separately prepared trial balance. Short first periods and periods spanning a fiscal reset cannot be remeasured by this import.` };
  if (period.currency !== prefs.currency) return { ok: false, outcome: "currency_mismatch", message: "The saved reporting currency differs from QuickBooks home currency. No currency conversion is performed; confirm the source and reporting currency." };
  return { ok: true, basis: { kind: "fiscal-ytd-as-of", fiscalStartMonth: prefs.month, fiscalStart, asOf: period.end, accountingMethod: prefs.method, currency: prefs.currency, preferencesSha256 } };
}