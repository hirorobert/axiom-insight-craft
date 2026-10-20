/**
 * tbCurrencyLabels — the explicit currency labels a trial balance file states about its own amounts, read with the
 * ingestion reader itself (tbSource → tbIngestion): amount-column headers such as "Debit TZS" and standalone label rows
 * under the amount columns, each with its location. The same labels the check compares with the period's currency
 * (CURRENCY_MISMATCH), so a browser can read them on the exact bytes before an upload, with no second parser.
 *
 * Read-only and pure: nothing is chosen, converted or stored. Used by the browser (src/lib/ingestion/fileCurrencyCheck,
 * loaded lazily); no edge function needs it.
 */
import { readTrialBalanceSource, type XlsxLike } from "./tbSource.ts";

export interface CurrencyLabel { code: string; row: number; column: string }
export type CurrencyLabelRead = { kind: "read"; labels: CurrencyLabel[] } | { kind: "unread" };

/**
 * The reader stops before the columns without a supported currency in its context. The labels it records never depend
 * on which one (only the issues it raises do, and none is used here), so the read always uses this one. It is a
 * reading parameter only: nothing is chosen, stored or defaulted from it.
 */
const READ_CURRENCY = "USD";

/** Without a period year the reader stops before the columns: "unread", never "no labels". */
export function readCurrencyLabels(bytes: Uint8Array, fileName: string, xlsx: XlsxLike, periodYear: number | null): CurrencyLabelRead {
  if (periodYear === null || !Number.isInteger(periodYear)) return { kind: "unread" };
  try {
    const result = readTrialBalanceSource(bytes, { fileName, periodYear, currency: READ_CURRENCY }, xlsx);
    // No columns detected: the reader stopped first (unreadable, too large, empty, no header, several candidate
    // sheets…). It never looked for labels, so no claim is made; the check itself will say why.
    if (Object.keys(result.columns ?? {}).length === 0) return { kind: "unread" };
    return { kind: "read", labels: (result.evidence?.currencyLabels ?? []).map((l) => ({ code: l.code, row: l.row, column: l.column })) };
  } catch {
    return { kind: "unread" };
  }
}
