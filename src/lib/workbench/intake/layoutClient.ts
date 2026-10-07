/**
 * The browser's ONLY path to manual trial-balance layouts: the trial-balance-layout Edge Function (I1-A, A2). The
 * browser never writes layout_templates or layout_confirmations; it sends what the person chose and shows what the
 * server answers. The server validates the whole file itself and decides every refusal.
 *
 * Answers are typed, never raw errors:
 *   ok           the server's answer;
 *   unavailable  the function or its database authority is not deployed yet → the feature is shown as unavailable and
 *                the existing automatic intake keeps working (no error state);
 *   conflict     the record changed since it was read (expected version) → offer Reload, record nothing;
 *   refused      a named refusal with plain copy (and, for a layout that does not fit, the full report);
 *   invalid      the layout is incomplete (reasons listed).
 */

export type NumberFormatId = "comma_dot" | "space_dot" | "apostrophe_dot" | "plain_dot" | "dot_comma" | "space_comma" | "plain_comma";

export interface LayoutProfile {
  format: "layout-template/1";
  sheet: { kind: "csv" } | { kind: "sheet"; name: string };
  headerRow: number;
  columns: { accountCode: string | null; accountName: string | null; debit: string | null; credit: string | null; balance: string | null; dimensions: string[] };
  numberFormat: NumberFormatId;
  balanceSign: "debit_positive" | "credit_positive" | null;
}

export interface InspectSheet {
  name: string | null;
  rowCount: number;
  preview: { rowNumber: number; cells: (string | null)[] }[];
  suggestion: { headerRow: number; columns: Record<string, string> } | null;
  numberFormats: { consistent: NumberFormatId[]; ambiguous: boolean; textCells: number };
}
export interface InspectResult {
  status: "ok" | "unreadable";
  kind?: "csv" | "workbook";
  sourceFileHash: string;
  currentConfirmationNo: number;
  sheets?: InspectSheet[];
  issue?: { code: string; message: string };
}
export interface LayoutIssue { code: string; severity: string; message: string; rows?: number[]; field?: string }
export interface LayoutReport {
  layoutFits: boolean;
  profileSha256: string;
  resolvedProfileSha256: string | null;
  sourceFileHash: string;
  currency: string | null;
  issues: LayoutIssue[];
  lineageSummary: Record<string, number>;
  totals: { debit: string; credit: string; difference: string } | null;
  accounts: number;
  rows: [number, string, string | null][];
  /** The whole file's amount columns: which number formats they can be read in, and examples whose value depends on it. */
  numberFormats?: {
    declared: NumberFormatId;
    consistent: NumberFormatId[];
    ambiguous: boolean;
    textCells: number;
    examples: { row: number; column: string; text: string; readings: Partial<Record<NumberFormatId, string>> }[];
  } | null;
}

export type LayoutAnswer<T> =
  | { kind: "ok"; value: T }
  | { kind: "unavailable" }
  | { kind: "conflict"; current: number | null; message: string }
  | { kind: "refused"; code: string; message: string; report?: LayoutReport }
  | { kind: "invalid"; message: string; errors: string[] };

/** The invoke surface used (supabase.functions.invoke). An HTTP error carries the Response as `context`. */
export type LayoutInvoke = (name: "trial-balance-layout", options: { body: Record<string, unknown> }) =>
  Promise<{ data: unknown; error: unknown }>;

async function errorBody(error: unknown): Promise<{ status: number | null; body: Record<string, unknown> | null }> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    const res = ctx as Response;
    try { return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> }; } catch { return { status: res.status, body: null }; }
  }
  return { status: null, body: null };
}

/** Maps one answer of the function. Pure apart from reading an error response body. */
export async function interpret<T>(result: { data: unknown; error: unknown }): Promise<LayoutAnswer<T>> {
  if (!result.error) return { kind: "ok", value: result.data as T };
  const name = (result.error as { name?: unknown }).name;
  const { status, body } = await errorBody(result.error);
  const code = typeof body?.code === "string" ? body.code : null;
  // Not deployed: the function is missing (404 / relay or fetch failure for an unknown function), or its database
  // authority is not applied yet (503 LAYOUT_AUTHORITY_UNAVAILABLE).
  if (status === 404 || code === "LAYOUT_AUTHORITY_UNAVAILABLE" || name === "FunctionsRelayError") return { kind: "unavailable" };
  const message = typeof body?.message === "string" ? body.message : "The layout request could not be completed. Nothing was changed.";
  if (code === "VERSION_CONFLICT") {
    const current = typeof body?.currentConfirmationNo === "number" ? body.currentConfirmationNo : typeof body?.currentVersion === "number" ? body.currentVersion : null;
    return { kind: "conflict", current, message };
  }
  if (status === 400) return { kind: "invalid", message, errors: Array.isArray(body?.errors) ? (body!.errors as string[]) : [] };
  if (code) return { kind: "refused", code, message, ...(body?.report ? { report: body.report as LayoutReport } : {}) };
  throw result.error;
}

export function layoutClient(invoke: LayoutInvoke) {
  const send = async <T>(body: Record<string, unknown>) => interpret<T>(await invoke("trial-balance-layout", { body }));
  return {
    inspect: (uploadId: string) => send<InspectResult>({ action: "inspect", uploadId }),
    validate: (uploadId: string, layout: LayoutProfile) => send<{ status: "validated"; report: LayoutReport }>({ action: "validate", uploadId, layout }),
    confirm: (uploadId: string, layout: LayoutProfile, expectedConfirmationNo: number, templateId: string | null, numberFormatConfirmed = false) =>
      send<{ status: "confirmed"; confirmationId: string; confirmationNo: number; replay: boolean; unchanged: boolean; report: LayoutReport }>(
        { action: "confirm", uploadId, layout, expectedConfirmationNo, templateId, numberFormatConfirmed }),
    saveTemplate: (companyId: string, templateKey: string, expectedVersion: number, name: string, layout: LayoutProfile) =>
      send<{ status: "saved"; templateId: string; templateKey: string; version: number; replay: boolean; unchanged: boolean }>(
        { action: "save_template", companyId, templateKey, expectedVersion, name, layout }),
  };
}
export type LayoutClient = ReturnType<typeof layoutClient>;
