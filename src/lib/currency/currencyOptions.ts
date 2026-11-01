/**
 * currencyOptions — the pure parts of the searchable currency selector (src/components/currency/CurrencySelect.tsx):
 * option labels, ISO names and matching. Nothing here chooses or defaults a currency.
 */

export interface CurrencyOption { code: string; name?: string | null }

export const CURRENCY_SELECT_COPY = {
  placeholder: "Type a code or name, then choose",
  loading: "Loading currencies…",
  none: "No currencies found",
} as const;

export const currencyLabel = (o: CurrencyOption) => (o.name ? `${o.code} · ${o.name}` : o.code);

/** ISO 4217 names in English where the browser knows them (Intl.DisplayNames); the code alone otherwise. */
export function isoCurrencyOptions(codes: readonly string[]): CurrencyOption[] {
  let names: { of(code: string): string | undefined } | null = null;
  try { names = new Intl.DisplayNames(["en"], { type: "currency" }); } catch { names = null; }
  return codes.map((code) => {
    let name: string | null = null;
    try { const n = names?.of(code); name = n && n !== code ? n : null; } catch { name = null; }
    return { code, name };
  });
}

/** The currencies the Add company form listed before it offered the whole registry: they stay at the top, in this order. */
export const ADD_COMPANY_FEATURED_CURRENCIES: readonly string[] = ["USD", "EUR", "GBP", "GHS", "KES", "NGN", "TZS", "UGX", "ZAR"];

/**
 * Every registry currency, with the `featured` codes first (in the order given) and the rest alphabetical by code. A featured
 * code the registry does not hold is refused, so the list can never offer a currency the server would reject.
 */
export function orderedCurrencyOptions(registryCodes: readonly string[], featured: readonly string[]): CurrencyOption[] {
  const known = new Set(registryCodes);
  const missing = featured.filter((c) => !known.has(c));
  if (missing.length > 0) throw new Error(`Featured currencies are not in the registry: ${missing.join(", ")}`);
  const first = new Set(featured);
  return isoCurrencyOptions([...featured, ...[...registryCodes].filter((c) => !first.has(c)).sort()]);
}

/** The options matching a query (code or name, case-insensitive). An empty query matches everything. */
export function filterCurrencies(options: readonly CurrencyOption[], query: string): CurrencyOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter((o) => o.code.toLowerCase().includes(q) || (o.name ?? "").toLowerCase().includes(q));
}
