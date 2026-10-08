/**
 * layout-assist — AI-ASSISTED layout suggestions for a trial-balance file the automatic reading could not read (I1-C).
 *
 * The suggestion is advisory and constrained:
 *   - the provider sees only an ai-sample/1: the first rows of the file with every cell reduced to a SHAPE (numbers → digit
 *     pattern, dates → "date", text → a length class) unless the text is an allow-listed column-heading word; sheets and
 *     columns are referred to by index. No account name, amount, company name or sheet name leaves the server;
 *   - the provider returns layout-proposal/1 JSON only (sheet index, header row, column INDICES, number format, balance
 *     sign). Anything else is refused. The server maps indices back to the file's real headers to build a
 *     layout-template/1, then validates it against the WHOLE file deterministically (the existing validate path);
 *   - nothing here confirms a layout, changes an amount, approves a classification or decides a treatment. The person
 *     reviews the suggestion and confirms it through the existing confirm path, or sets the layout manually.
 *
 * Before any provider call: a provider must be configured (none is wired today — external calls are disabled), the
 * caller must be authorized for the file (the layout handler's own inspect), the automatic reading must have failed, and
 * the database must reserve the run (current workspace consent, per-user daily quota, monthly cost cap).
 */
import { canonicalJson, sha256Hex } from "./hash.ts";
import { LAYOUT_TEMPLATE_FORMAT, NUMBER_FORMAT_IDS, validateProfile, type LayoutProfile, type NumberFormatId } from "./layoutProfile.ts";
import { handleLayoutRequest, type LayoutDeps, type LayoutResponse } from "./trialBalanceLayout.ts";

export const AI_SAMPLE_FORMAT = "ai-sample/1";
export const LAYOUT_PROPOSAL_FORMAT = "layout-proposal/1";
export const SAMPLE_ROWS = 15;
export const SAMPLE_COLUMNS = 30;
const MAX_SHEETS = 10;

// Column-heading words that may be sent verbatim (normalized: lower case, letters only). Everything else is a shape.
const HEADING_WORDS = new Set([
  "account", "accounts", "acct", "code", "codes", "no", "number", "num", "name", "names", "description", "desc", "title", "ledger",
  "gl", "nominal", "debit", "debits", "dr", "credit", "credits", "cr", "balance", "balances", "bal", "net", "amount", "amounts",
  "total", "totals", "opening", "closing", "movement", "movements", "period", "year", "ytd", "current", "prior", "previous", "end",
  "beginning", "begin", "trial", "tb", "type", "class", "category", "group", "department", "dept", "cost", "centre", "center",
  "project", "segment", "currency", "ccy", "local", "reporting", "soll", "haben", "saldo", "konto", "bezeichnung", "debe", "haber",
  "cuenta", "debito", "credito", "compte", "libelle", "solde", "debit", "crediti", "conto", "dare", "avere", "jina", "akaunti",
]);

export type SampleCell = string;
export interface AiSampleSheet { index: number; kind: "csv" | "sheet"; rowCount: number; rows: SampleCell[][] }
export interface AiSample { format: typeof AI_SAMPLE_FORMAT; sheets: AiSampleSheet[] }

const NUMERIC = /^[\s(+\-−]*[$€£¥₹]?\s*\d[\d\s.,'’ ]*\s*[)%]?\s*(?:CR|DR|Cr|Dr)?$/;
const DATE = /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;

/** One cell → the token the provider may see. Never the cell's text unless it is an allow-listed heading word(s). */
export function sampleToken(cell: string | null): SampleCell {
  if (cell === null || cell.trim() === "") return "";
  const t = cell.trim();
  if (/^(19|20)\d{2}$/.test(t)) return `year:${t}`;                     // a year column heading (FY selection needs it)
  if (DATE.test(t)) return "date";
  if (NUMERIC.test(t)) {
    // The digit pattern only: separators, sign, brackets and DR/CR markers are kept (number format and sign evidence);
    // every digit becomes 9 and runs longer than 4 are capped, so no amount survives.
    return `num:${t.replace(/\d/g, "9").replace(/9{5,}/g, "9999+").replace(/[$€£¥₹]/g, "¤").replace(/\s+/g, " ")}`;
  }
  const words = t.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length > 0 && words.length <= 4 && words.every((w) => HEADING_WORDS.has(w)) && t.length <= 40) return `head:${words.join(" ")}`;
  return t.length <= 12 ? "text:short" : t.length <= 40 ? "text:medium" : "text:long";
}

export interface InspectSheet { name: string | null; rowCount: number; preview: { rowNumber: number; cells: (string | null)[] }[]; suggestion: unknown }

export function buildAiSample(sheets: InspectSheet[]): AiSample {
  return {
    format: AI_SAMPLE_FORMAT,
    sheets: sheets.slice(0, MAX_SHEETS).map((s, index) => ({
      index, kind: s.name === null ? "csv" : "sheet", rowCount: s.rowCount,
      rows: s.preview.slice(0, SAMPLE_ROWS).map((r) => r.cells.slice(0, SAMPLE_COLUMNS).map(sampleToken)),
    })),
  };
}

export interface LayoutProposal {
  format: typeof LAYOUT_PROPOSAL_FORMAT;
  sheetIndex: number;
  headerRow: number;
  columns: { accountCode: number | null; accountName: number | null; debit: number | null; credit: number | null; balance: number | null; dimensions: number[] };
  numberFormat: NumberFormatId;
  balanceSign: "debit_positive" | "credit_positive" | null;
}

/**
 * Strict: exactly the layout-proposal/1 fields, indices inside the sample, then mapped to the file's real header texts and
 * checked by the same validateProfile as a person's layout. Returns errors, never a partial layout.
 */
export function proposalToProfile(raw: unknown, sheets: InspectSheet[]): { ok: true; profile: LayoutProfile; proposal: LayoutProposal } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["The suggestion is not an object."] };
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["format", "sheetIndex", "headerRow", "columns", "numberFormat", "balanceSign"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) errors.push(`Unknown field ${k}.`);
  if (o.format !== LAYOUT_PROPOSAL_FORMAT) errors.push(`format must be ${LAYOUT_PROPOSAL_FORMAT}.`);
  const sheetIndex = o.sheetIndex;
  const sheet = Number.isInteger(sheetIndex) ? sheets[sheetIndex as number] : undefined;
  if (!sheet || (sheetIndex as number) >= MAX_SHEETS) errors.push("sheetIndex is not a sheet of the sample.");
  const headerRow = o.headerRow;
  const headerCells = sheet && Number.isInteger(headerRow) && (headerRow as number) >= 1 && (headerRow as number) <= SAMPLE_ROWS
    ? sheet.preview.find((r) => r.rowNumber === headerRow)?.cells ?? null : null;
  if (!headerCells) errors.push("headerRow is not a row of the sample.");
  const c = o.columns as Record<string, unknown> | undefined;
  const roles = ["accountCode", "accountName", "debit", "credit", "balance"] as const;
  if (!c || typeof c !== "object" || Array.isArray(c)) errors.push("columns must be an object.");
  else for (const k of Object.keys(c)) if (![...roles, "dimensions"].includes(k)) errors.push(`Unknown column role ${k}.`);
  const header = (i: unknown): string | null | undefined => {
    if (i === null) return null;
    if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= SAMPLE_COLUMNS || !headerCells) return undefined;
    const h = headerCells[i as number];
    return h === null || h === undefined || h.trim() === "" ? undefined : h;
  };
  const mapped: Record<string, string | null> = {};
  for (const r of roles) {
    const h = header(c?.[r] ?? null);
    if (h === undefined) errors.push(`${r} does not name a heading cell of the header row.`);
    else mapped[r] = h;
  }
  const dims = Array.isArray(c?.dimensions) ? (c!.dimensions as unknown[]) : null;
  if (!dims) errors.push("dimensions must be a list.");
  const dimHeaders = (dims ?? []).map(header);
  if (dimHeaders.some((h) => !h)) errors.push("Every dimension must name a heading cell of the header row.");
  if (!NUMBER_FORMAT_IDS.includes(o.numberFormat as NumberFormatId)) errors.push("numberFormat is not a known format.");
  if (errors.length > 0) return { ok: false, errors };
  const v = validateProfile({
    format: LAYOUT_TEMPLATE_FORMAT,
    sheet: sheet!.name === null ? { kind: "csv" } : { kind: "sheet", name: sheet!.name },
    headerRow,
    columns: { ...mapped, dimensions: dimHeaders as string[] },
    numberFormat: o.numberFormat,
    balanceSign: o.balanceSign ?? null,
  });
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, profile: v.profile, proposal: { ...(o as unknown as LayoutProposal), columns: { ...(c as LayoutProposal["columns"]) } } };
}

// ── The provider seam. No external adapter is wired: external AI calls stay disabled until approved. ───────────────────
export interface LayoutAssistProvider {
  readonly id: string;
  readonly model: string;
  readonly promptVersion: string;
  /** Returns the raw proposal JSON and the call's cost in micro-units (null when the provider did not report it). */
  propose(sample: AiSample, signal: AbortSignal): Promise<{ proposal: unknown; costMicros: number | null }>;
}

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };
export interface LayoutAssistDeps {
  layout: LayoutDeps;
  /** null = no provider configured (the production wiring today). */
  provider: LayoutAssistProvider | null;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcAnswer>;
  timeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANUAL = "Set the layout manually — the editor is always available.";
const COPY: Record<string, [number, string]> = {
  PROVIDER_DISABLED: [503, `Layout suggestions are not available. ${MANUAL}`],
  CONSENT_REQUIRED: [403, `Layout suggestions need the workspace's consent to send a minimized sample of the file. ${MANUAL}`],
  QUOTA_EXCEEDED: [429, `You have used today's layout suggestions. ${MANUAL}`],
  AI_BUDGET_EXCEEDED: [429, `This workspace's layout-suggestion budget is used up. ${MANUAL}`],
  FORBIDDEN: [403, "You don't have permission to set up layouts in this workspace."],
  REQUEST_ID_REUSED: [409, "This request id was already used for another file. Start a new suggestion."],
  IN_PROGRESS: [409, "This suggestion is still being prepared. Try again in a moment."],
  AUTOMATIC_READING_AVAILABLE: [409, "The automatic reading already understands this sheet; no suggestion is needed."],
  PROVIDER_FAILED: [502, `No suggestion could be produced. ${MANUAL}`],
  SUGGESTION_UNUSABLE: [422, `The suggestion did not describe a usable layout. ${MANUAL}`],
  UNREADABLE: [422, "The file could not be read, so no layout can be suggested."],
  LAYOUT_ASSIST_UNAVAILABLE: [503, `Layout suggestions are not available yet. ${MANUAL}`],
};
const refused = (code: string, extra: Record<string, unknown> = {}): LayoutResponse =>
  ({ status: COPY[code]?.[0] ?? 409, body: { status: "refused", code, message: COPY[code]?.[1] ?? "The request was refused.", ...extra } });
const bad = (message: string): LayoutResponse => ({ status: 400, body: { status: "invalid", code: "INVALID_REQUEST", message } });
const isMissing = (e: RpcAnswer["error"]) => !!e && ["PGRST202", "42883", "PGRST205", "42P01"].includes(e.code ?? "");

async function complete(deps: LayoutAssistDeps, runId: string, state: "proposed" | "invalid" | "failed", fields: {
  costMicros: number | null; proposal?: unknown; proposalSha256?: string | null; validation?: unknown; failureCode?: string | null;
}) {
  const { error } = await deps.rpc("ai_layout_assist_complete", {
    p_run_id: runId, p_state: state, p_actual_cost_micros: fields.costMicros, p_proposal: fields.proposal ?? null,
    p_proposal_sha256: fields.proposalSha256 ?? null, p_validation: fields.validation ?? null, p_failure_code: fields.failureCode ?? null,
  });
  if (error) throw new Error(`ai_layout_assist_complete failed: ${error.code ?? "unknown"}`);
}

export async function handleLayoutAssist(userId: string, body: unknown, deps: LayoutAssistDeps): Promise<LayoutResponse> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.action !== "suggest") return bad("action must be suggest.");
  if (typeof b.uploadId !== "string" || !UUID.test(b.uploadId)) return bad("uploadId must be a UUID.");
  if (typeof b.requestId !== "string" || !UUID.test(b.requestId)) return bad("requestId must be a UUID.");
  const sheetIndex = b.sheetIndex ?? 0;
  if (!Number.isInteger(sheetIndex) || (sheetIndex as number) < 0) return bad("sheetIndex must be a sheet number.");
  // No provider: refused before anything is read.
  if (!deps.provider) return refused("PROVIDER_DISABLED");

  // The layout handler's own inspect: authorization, plan, active upload, source binding, then the file.
  const inspected = await handleLayoutRequest(userId, { action: "inspect", uploadId: b.uploadId }, deps.layout);
  if (inspected.status !== 200) return inspected;
  if (inspected.body.status !== "ok") return refused("UNREADABLE");
  const sheets = inspected.body.sheets as InspectSheet[];
  const target = sheets[sheetIndex as number];
  if (!target) return bad("sheetIndex is not a sheet of this file.");
  if (target.suggestion) return refused("AUTOMATIC_READING_AVAILABLE");

  const sample = buildAiSample(sheets);
  const sampleSha256 = await sha256Hex(canonicalJson(sample as never));
  const { data, error } = await deps.rpc("ai_layout_assist_reserve", { p_user_id: userId, p_upload_id: b.uploadId, p_request_id: b.requestId, p_sample_sha256: sampleSha256 });
  if (isMissing(error)) return refused("LAYOUT_ASSIST_UNAVAILABLE");
  if (error) throw new Error(`ai_layout_assist_reserve failed: ${error.code ?? "unknown"}`);
  const r = data as { outcome: string; code?: string; runId?: string; state?: string; replay?: boolean; proposal?: unknown; validation?: unknown; failureCode?: string | null };
  if (r.outcome !== "reserved" || !r.runId) return refused(r.code ?? "FORBIDDEN");
  if (r.replay) {
    if (r.state === "reserved") return refused("IN_PROGRESS");
    if (r.state === "proposed") return { status: 200, body: { status: "proposed", runId: r.runId, advisory: true, layout: r.proposal, report: r.validation, replay: true } };
    return refused(r.state === "invalid" ? "SUGGESTION_UNUSABLE" : "PROVIDER_FAILED", { runId: r.runId });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
  let answer: { proposal: unknown; costMicros: number | null };
  try {
    answer = await deps.provider.propose(sample, controller.signal);
  } catch {
    // Cost unknown: recorded at the reserved ceiling (null → ceiling), never as free.
    await complete(deps, r.runId, "failed", { costMicros: null, failureCode: "PROVIDER_FAILED" });
    return refused("PROVIDER_FAILED", { runId: r.runId });
  } finally {
    clearTimeout(timer);
  }

  const mapped = proposalToProfile(answer.proposal, sheets);
  if (!mapped.ok) {
    await complete(deps, r.runId, "invalid", { costMicros: answer.costMicros, failureCode: "PROPOSAL_INVALID", validation: { errors: mapped.errors.slice(0, 20) } });
    return refused("SUGGESTION_UNUSABLE", { runId: r.runId });
  }
  // Deterministic whole-file validation of the suggested layout — the same path as a person's layout.
  const validated = await handleLayoutRequest(userId, { action: "validate", uploadId: b.uploadId, layout: mapped.profile }, deps.layout);
  if (validated.status !== 200) {
    await complete(deps, r.runId, "invalid", { costMicros: answer.costMicros, failureCode: "VALIDATION_REFUSED" });
    return validated;
  }
  const report = validated.body.report as Record<string, unknown> & { rows?: unknown };
  const { rows: _rows, ...summary } = report;
  await complete(deps, r.runId, "proposed", {
    costMicros: answer.costMicros, proposal: mapped.profile, proposalSha256: await sha256Hex(canonicalJson(mapped.profile as never)), validation: summary,
  });
  return { status: 200, body: { status: "proposed", runId: r.runId, advisory: true, layout: mapped.profile, report, replay: false } };
}
