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

/** The options matching a query (code or name, case-insensitive). An empty query matches everything. */
export function filterCurrencies(options: readonly CurrencyOption[], query: string): CurrencyOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter((o) => o.code.toLowerCase().includes(q) || (o.name ?? "").toLowerCase().includes(q));
}
