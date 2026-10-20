/**
 * investigationRows — the ONLY browser read of an investigation's stored rows (get_tb_investigation_rows, 20261118100000).
 *
 * The reader's own rows were stored ONCE when the investigation ran (included and excluded, source row, exact minor-unit
 * amounts, the reason a row was left out); a page is read from that store by keyset (ordinal), at most 200 rows — the
 * file is never parsed again for a page. The read is strict: anything malformed is "unavailable", never a partial page.
 */
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export type RowFilter = "all" | "included" | "excluded";
export const ROW_FILTERS: readonly RowFilter[] = ["all", "included", "excluded"];
export const ROWS_PAGE = 50;

export interface InvestigationRowView {
  ordinal: number;
  rowNumber: number;
  included: boolean;
  disposition: string;
  accountCode: string | null;
  accountName: string | null;
  debitMinor: string | null;
  creditMinor: string | null;
  reason: string | null;
}
export type RowsPage =
  | { kind: "ok"; rows: InvestigationRowView[]; nextAfter: number | null; total: number }
  | { kind: "refused"; code: string }
  | { kind: "unavailable" };

/** A nullable string field: the value, or undefined when the field is missing or of another type. */
const str = (v: unknown): string | null | undefined => (v === null || typeof v === "string" ? (v as string | null) : undefined);
const MINOR = /^-?\d{1,20}$/;

function readRow(x: unknown): InvestigationRowView | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const [code, name, d, c, reason] = [str(r.account_code), str(r.account_name), str(r.debit_minor), str(r.credit_minor), str(r.reason)];
  if (!Number.isInteger(r.ordinal) || !Number.isInteger(r.row_number) || typeof r.included !== "boolean" || typeof r.disposition !== "string"
      || code === undefined || name === undefined || d === undefined || c === undefined || reason === undefined
      || (d !== null && !MINOR.test(d)) || (c !== null && !MINOR.test(c))) return null;
  return { ordinal: r.ordinal as number, rowNumber: r.row_number as number, included: r.included, disposition: r.disposition,
    accountCode: code, accountName: name, debitMinor: d, creditMinor: c, reason };
}

export async function fetchInvestigationRows(rpc: Rpc, investigationId: string, filter: RowFilter, after: number, limit = ROWS_PAGE): Promise<RowsPage> {
  const { data, error } = await rpc("get_tb_investigation_rows", { p_investigation_id: investigationId, p_filter: filter, p_after: after, p_limit: limit });
  if (error || !data || typeof data !== "object") return { kind: "unavailable" };
  const d = data as Record<string, unknown>;
  if (d.outcome === "refused" && typeof d.code === "string") return { kind: "refused", code: d.code };
  if (d.outcome !== "ok" || !Array.isArray(d.rows) || !Number.isInteger(d.total) || !(d.next_after === null || Number.isInteger(d.next_after))) return { kind: "unavailable" };
  const rows = d.rows.map(readRow);
  if (rows.some((r) => r === null) || rows.length > limit) return { kind: "unavailable" };
  return { kind: "ok", rows: rows as InvestigationRowView[], nextAfter: (d.next_after as number | null) ?? null, total: d.total as number };
}

/** Exact minor units as a grouped decimal ("123456" at exponent 2 → "1,234.56"); null stays empty. Never through a float. */
export function formatMinor(minor: string | null, exponent: number): string {
  if (minor === null) return "";
  const neg = minor.startsWith("-");
  const digits = (neg ? minor.slice(1) : minor).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : "";
  return `${neg ? "-" : ""}${whole}${frac}`;
}
