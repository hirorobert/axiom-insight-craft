/**
 * fileCurrencyCheck — the currency a trial balance file states about its own amounts, read BEFORE the check runs, on the
 * exact bytes being uploaded, with the server's own reader (supabase/functions/_shared/tbCurrencyLabels.ts). The server
 * refuses a check whose labels contradict the period's currency (CURRENCY_MISMATCH), so reading them first lets the
 * person fix the choice before anything is recorded. Nothing is changed silently and no amount is converted.
 *
 *   none      no explicit currency label: nothing to confirm;
 *   match     every label names the selected currency;
 *   conflict  every label names ONE other currency (or none is selected yet): the person chooses explicitly;
 *   mixed     labels name more than one currency: the file contradicts itself and must be corrected;
 *   unread    the file could not be read here (the server's check will say why): no claim is made.
 *
 * The reader and the workbook library load only when a file is chosen, as their own chunk.
 */
export interface CurrencyLabelEvidence { code: string; row: number; column: string }
export type FileCurrency =
  | { kind: "none" }
  | { kind: "match"; code: string; evidence: CurrencyLabelEvidence[] }
  | { kind: "conflict"; code: string; selected: string; evidence: CurrencyLabelEvidence[] }
  | { kind: "mixed"; codes: string[]; evidence: CurrencyLabelEvidence[] }
  | { kind: "unread" };

/** Pure: the decision from the labels and the selected currency (null or "": no choice yet). */
export function classifyLabels(labels: readonly CurrencyLabelEvidence[], selected: string | null): FileCurrency {
  const evidence = [...labels];
  const codes = [...new Set(evidence.map((l) => l.code.toUpperCase()))].sort();
  if (codes.length === 0) return { kind: "none" };
  if (codes.length > 1) return { kind: "mixed", codes, evidence };
  const code = codes[0];
  if (selected && code === selected.toUpperCase()) return { kind: "match", code, evidence };
  return { kind: "conflict", code, selected: (selected ?? "").toUpperCase(), evidence };
}

/** The labels a read found ([] for none or unread). */
export function labelsOf(f: FileCurrency): CurrencyLabelEvidence[] {
  return f.kind === "none" || f.kind === "unread" ? [] : f.evidence;
}

/** The shape of tbCurrencyLabels' export (declared here so the type program never reaches the reader; pinned by
 *  fileCurrencyCheck.test.ts, which runs the real module). */
interface LabelReader {
  readCurrencyLabels(bytes: Uint8Array, fileName: string, xlsx: unknown, periodYear: number | null):
    { kind: "read"; labels: CurrencyLabelEvidence[] } | { kind: "unread" };
}
// A glob, not an import: the reader enters its own lazy chunk and stays out of the app's type program (it is checked
// with the edge functions, whose stricter settings it is written for).
const readers = import.meta.glob<LabelReader>("../../../supabase/functions/_shared/tbCurrencyLabels.ts");

/** Reads the file's explicit currency labels with the server's own reader. Any failure here is "unread", never a guess. */
export async function checkFileCurrency(file: Blob & { name: string }, selected: string | null, periodYear: number | null): Promise<FileCurrency> {
  try {
    const load = Object.values(readers)[0];
    if (!load) return { kind: "unread" };
    const [{ readCurrencyLabels }, xlsx, buffer] = await Promise.all([load(), import("xlsx"), file.arrayBuffer()]);
    const r = readCurrencyLabels(new Uint8Array(buffer), file.name, xlsx, periodYear);
    return r.kind === "unread" ? r : classifyLabels(r.labels, selected);
  } catch {
    return { kind: "unread" };
  }
}

/** Where the file says it: "row 5" or "rows 5, 6", for the message. */
export function describeEvidence(evidence: readonly CurrencyLabelEvidence[]): string {
  const rows = [...new Set(evidence.map((e) => e.row))].sort((a, b) => a - b);
  return rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.slice(0, 3).join(", ")}${rows.length > 3 ? "…" : ""}`;
}
