/** Preset reasons for a currency correction. None is pre-selected: the person picks one explicitly. */
export const CURRENCY_REASON_PRESETS = ["chosen_by_mistake", "client_reports_in", "other"] as const;
export type CurrencyReasonPreset = (typeof CURRENCY_REASON_PRESETS)[number];
export function currencyReasonText(p: CurrencyReasonPreset, from: string, to: string): string {
  return p === "chosen_by_mistake" ? `The ledger is kept in ${to}; ${from} was chosen by mistake.`
    : p === "client_reports_in" ? `The client reports in ${to}.`
    : "Other reason";
}
/** The reason sent to the server, or null while it is not yet complete (no preset, or "Other" without 3+ characters). */
export function composeCurrencyReason(p: CurrencyReasonPreset | null, details: string, from: string, to: string): string | null {
  const note = details.trim();
  if (p === null) return null;
  if (p === "other") return note.length >= 3 ? note : null;
  const text = currencyReasonText(p, from, to);
  return note ? `${text} ${note}` : text;
}
