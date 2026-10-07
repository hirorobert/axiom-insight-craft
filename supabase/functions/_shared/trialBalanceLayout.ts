/**
 * trial-balance-layout — the server side of the manual layout editor (I1-A, A2).
 *
 *   inspect        the file's sheets and first rows, the automatic reading as a starting suggestion, the number-format
 *                  evidence and the upload's current confirmation number (for the expected-version check);
 *   validate       a layout applied to the WHOLE file: every row's disposition, every issue, totals — nothing written;
 *   confirm        validate again on the server (the client's report is never trusted) and, when the layout fits the
 *                  file, record an append-only confirmation bound to the source hash and the resolved layout hash
 *                  (expected confirmation number; a retry replays);
 *   save_template  record a reusable template version (expected version; a retry replays). A template has no file.
 *
 * Who: the same processing authority as process-trial-balance for the file (actor resolution, current plan, active
 * upload, source binding); writes additionally need prepare_close — decided in the database by the writer functions,
 * which derive the actor from the JWT user (nothing in the body names an actor).
 *
 * Pure (dependencies injected): the edge function wires Supabase; tests and the database proof drive it directly.
 */

import { sha256HexBytes } from "./hash.ts";
import {
  NUMBER_FORMATS, NUMBER_FORMAT_IDS, canonicalAmountBody, numberFormatEvidence, profileSha256, resolvedLayoutSha256, validateProfile,
  type LayoutProfile, type NumberFormatId, type ResolvedLayout,
} from "./layoutProfile.ts";
import { isMissingRelation, readCurrentLayoutConfirmation, type LayoutReadClient } from "./layoutConfirmationRead.ts";
import { resolveProcessingActor } from "./processingActor.ts";
import { processingEntitlementRefusal } from "./paidAction.ts";
import { PROCESSING_FORBIDDEN, processingRefusal, sourceBindingRefusal } from "./uploadLifecycle.ts";
import { detectColumns, formatMinor, TB_INGESTION_VERSION, type Cell, type IngestResult, type SourceRow } from "./tbIngestion.ts";
import { readSourceTables, readTrialBalanceSourceWithLayout, type XlsxLike } from "./tbSource.ts";

export interface LayoutUpload {
  id: string;
  company_id: string | null;
  file_path: string | null;
  file_name: string | null;
  lifecycle_state: string | null;
  period_year: number | null;
}

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };
export interface LayoutDeps {
  loadUpload(uploadId: string): Promise<LayoutUpload | null>;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcAnswer>;
  db: LayoutReadClient;
  download(path: string): Promise<Uint8Array | null>;
  reportingCurrency(upload: LayoutUpload): Promise<string | null>;
  xlsx: XlsxLike;
}

export interface LayoutResponse { status: number; body: Record<string, unknown> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_ROWS = 40;
const PREVIEW_COLUMNS = 40;
const LAYOUT_ISSUE = /^LAYOUT_/;

const unavailable = (): LayoutResponse => ({
  status: 503,
  body: { status: "unavailable", code: "LAYOUT_AUTHORITY_UNAVAILABLE", message: "Manual layouts are not available yet. The automatic reading still works." },
});
const bad = (message: string, errors?: string[]): LayoutResponse => ({ status: 400, body: { status: "invalid", code: "INVALID_REQUEST", message, ...(errors ? { errors } : {}) } });
const isMissingFunction = (e: RpcAnswer["error"]) => !!e && (e.code === "PGRST202" || e.code === "42883");

const REFUSAL_STATUS: Record<string, number> = { NUMBER_FORMAT_AMBIGUOUS: 422, FORBIDDEN: 403, UPLOAD_NOT_FOUND: 403, VERSION_CONFLICT: 409, IN_PROGRESS: 409, REPROCESS_REQUIRED: 409, SOURCE_CHANGED: 409, UPLOAD_NOT_ACTIVE: 409, TEMPLATE_NOT_FOUND: 404, LAYOUT_DOES_NOT_FIT: 422 };
const REFUSAL_COPY: Record<string, string> = {
  FORBIDDEN: "You don't have permission to set up layouts in this workspace.",
  UPLOAD_NOT_FOUND: "You don't have permission to set up layouts in this workspace.",
  VERSION_CONFLICT: "Someone changed this since you opened it. Reload to see the current version, then try again.",
  IN_PROGRESS: "This trial balance is being checked right now. Confirm the layout when the check has finished.",
  REPROCESS_REQUIRED: "This trial balance has a current result from before layouts existed. Request a re-check first, then confirm the layout.",
  SOURCE_CHANGED: "The file no longer matches this upload. Upload it again.",
  UPLOAD_NOT_ACTIVE: "This trial balance is no longer in use, so its layout cannot change.",
  TEMPLATE_NOT_FOUND: "That layout template was not found in this workspace.",
  LAYOUT_DOES_NOT_FIT: "This layout does not fit the file. Correct it and validate again.",
  NUMBER_FORMAT_AMBIGUOUS: "The amounts in this file can be read in more than one number format, giving different values. Check the examples, choose the format your system exported, and confirm that choice explicitly.",
};
function refusal(code: string, extra: Record<string, unknown> = {}): LayoutResponse {
  return { status: REFUSAL_STATUS[code] ?? 409, body: { status: "refused", code, message: REFUSAL_COPY[code] ?? "The request was refused.", ...extra } };
}

/** The file of an upload, after the same checks process-trial-balance makes before it reads a source. */
async function openUpload(deps: LayoutDeps, userId: string, uploadId: unknown):
  Promise<{ ok: true; upload: LayoutUpload & { company_id: string }; bytes: Uint8Array; sourceFileHash: string } | { ok: false; response: LayoutResponse }> {
  if (typeof uploadId !== "string" || !UUID.test(uploadId)) return { ok: false, response: bad("uploadId must be a UUID.") };
  const upload = await deps.loadUpload(uploadId);
  if (!upload) return { ok: false, response: { status: 403, body: { ...PROCESSING_FORBIDDEN } } };
  if (!upload.company_id) return { ok: false, response: { status: 409, body: { status: "refused", code: "COMPANY_REQUIRED", message: "Layouts are set up inside a workspace." } } };
  const actor = await resolveProcessingActor((name, args) => deps.rpc(name, args), userId, upload.company_id);
  if (!actor) return { ok: false, response: { status: 403, body: { ...PROCESSING_FORBIDDEN } } };
  const noPlan = await processingEntitlementRefusal((name, args) => deps.rpc(name, args), userId, uploadId);
  if (noPlan) return { ok: false, response: { status: noPlan.httpStatus, body: noPlan.httpStatus === 403 ? { ...PROCESSING_FORBIDDEN } : { ...noPlan.body } } };
  const notActive = processingRefusal(upload.lifecycle_state);
  if (notActive) return { ok: false, response: { status: 409, body: { ...notActive } } };
  const { data: bound, error: bindErr } = await deps.rpc("tbu_upload_source_bound", { p_upload_id: uploadId });
  const unbound = sourceBindingRefusal(bindErr ? null : bound);
  if (unbound) return { ok: false, response: { status: 409, body: { ...unbound } } };
  const bytes = upload.file_path ? await deps.download(upload.file_path) : null;
  if (!bytes) return { ok: false, response: { status: 503, body: { status: "unavailable", code: "SOURCE_UNAVAILABLE", message: "The file could not be read right now. Nothing was changed; try again shortly." } } };
  return { ok: true, upload: upload as LayoutUpload & { company_id: string }, bytes, sourceFileHash: await sha256HexBytes(bytes) };
}

const cellText = (c: Cell): string | null => (c === null || c === undefined || c === "" ? null : String(c));

/** The full-file validation report of a layout (everything a person needs to decide; row dispositions included). */
export interface LayoutReport {
  layoutFits: boolean;
  profileSha256: string;
  resolvedProfileSha256: string | null;
  resolved: unknown;
  sourceFileHash: string;
  ingestVersion: string;
  currency: string | null;
  issues: { code: string; severity: string; message: string; rows?: number[]; field?: string }[];
  lineageSummary: IngestResult["lineageSummary"];
  totals: { debit: string; credit: string; difference: string } | null;
  accounts: number;
  rows: [number, string, string | null][];
  /**
   * The number formats every TEXT amount in the layout's amount columns (the whole file, below the header) can be read
   * in. `ambiguous`: two plausible formats give different values — the person must choose and confirm explicitly.
   * `examples`: up to three cells whose value depends on the format, with each plausible reading.
   */
  numberFormats: {
    declared: NumberFormatId;
    consistent: NumberFormatId[];
    ambiguous: boolean;
    textCells: number;
    examples: { row: number; column: string; text: string; readings: Partial<Record<NumberFormatId, string>> }[];
  } | null;
}

const AMOUNT_WRAPPER = /^\(?\s*[-+]?\s*(.*?)\s*\)?$/;
const amountBody = (t: string) => AMOUNT_WRAPPER.exec(t.replace(/[\u00a0\u202f\u2009]/g, " ").replace(/[’‘]/g, "'").trim())?.[1] ?? "";
/** A text cell that reads as an amount in at least one supported number format (labels and notes are not evidence). */
const isAmountText = (c: Cell): c is string => typeof c === "string" && NUMBER_FORMAT_IDS.some((f) => canonicalAmountBody(amountBody(c), f) !== null);

/** Number-format evidence over the WHOLE file's amount columns as the layout resolved them (deterministic). */
export function amountColumnEvidence(rows: SourceRow[], resolved: ResolvedLayout): NonNullable<LayoutReport["numberFormats"]> {
  const cols = [["debit", resolved.columns.debit], ["credit", resolved.columns.credit], ["balance", resolved.columns.balance]]
    .filter((x): x is [string, number] => x[1] !== null);
  const below = rows.filter((r) => r.rowNumber > resolved.headerRowNumber);
  const cells: { row: number; column: string; text: string }[] = [];
  for (const r of below) for (const [name, i] of cols) { const c = r.cells[i]; if (isAmountText(c)) cells.push({ row: r.rowNumber, column: name, text: c }); }
  const ev = numberFormatEvidence(cells.map((c) => c.text));
  const examples: NonNullable<LayoutReport["numberFormats"]>["examples"] = [];
  if (ev.ambiguous) {
    for (const c of cells) {
      const readings: Partial<Record<NumberFormatId, string>> = {};
      for (const f of ev.consistent) readings[f] = canonicalAmountBody(amountBody(c.text), f) ?? "";
      if (new Set(Object.values(readings)).size > 1) examples.push({ ...c, readings });
      if (examples.length === 3) break;
    }
  }
  return { declared: resolved.numberFormat, consistent: ev.consistent, ambiguous: ev.ambiguous, textCells: ev.textCells, examples };
}

async function buildReport(result: IngestResult, resolved: unknown, profileHash: string, sourceFileHash: string, numberFormats: LayoutReport["numberFormats"] = null): Promise<LayoutReport> {
  const exp = result.exponent ?? 0;
  const resolvedHash = resolved ? await resolvedLayoutSha256(resolved as never) : null;
  return {
    layoutFits: resolved !== null && !result.issues.some((i) => LAYOUT_ISSUE.test(i.code)),
    profileSha256: profileHash,
    resolvedProfileSha256: resolvedHash,
    resolved,
    sourceFileHash,
    ingestVersion: TB_INGESTION_VERSION,
    currency: result.currency,
    issues: result.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message, ...(i.rows ? { rows: i.rows } : {}), ...(i.field ? { field: i.field } : {}) })),
    lineageSummary: result.lineageSummary,
    totals: result.totals ? { debit: formatMinor(result.totals.debitMinor, exp), credit: formatMinor(result.totals.creditMinor, exp), difference: formatMinor(result.totals.differenceMinor, exp) } : null,
    accounts: result.accounts.length,
    rows: result.lineage.map((l) => [l.rowNumber, l.disposition, l.reason ?? l.identity ?? null]),
    numberFormats,
  };
}

async function validateOn(deps: LayoutDeps, opened: { upload: LayoutUpload; bytes: Uint8Array; sourceFileHash: string }, layout: unknown):
  Promise<{ ok: true; profile: LayoutProfile; report: LayoutReport } | { ok: false; response: LayoutResponse }> {
  const v = validateProfile(layout);
  if (!v.ok) return { ok: false, response: bad("The layout is incomplete.", v.errors) };
  const hash = await profileSha256(v.profile);
  const currency = await deps.reportingCurrency(opened.upload);
  const read = readTrialBalanceSourceWithLayout(opened.bytes, { fileName: opened.upload.file_name ?? "", periodYear: opened.upload.period_year ?? null, currency }, deps.xlsx, v.profile, hash);
  // The evidence comes from the same rows the layout read: the whole file, the layout's sheet, its amount columns.
  let evidence: LayoutReport["numberFormats"] = null;
  if (read.resolved) {
    const tables = readSourceTables(opened.bytes, opened.upload.file_name ?? "", deps.xlsx);
    const sheet = tables.ok ? (tables.kind === "csv" ? tables.sheets[0] : tables.sheets.find((x) => x.name === read.resolved!.sheetName)) : undefined;
    if (sheet) evidence = amountColumnEvidence(sheet.rows, read.resolved);
  }
  return { ok: true, profile: v.profile, report: await buildReport(read.result, read.resolved, hash, opened.sourceFileHash, evidence) };
}

/** What the confirmation records as its validation (the resolved layout is stored in its own column). */
function validationSummary(summary: Omit<LayoutReport, "rows">): Record<string, unknown> {
  const { resolved: _resolved, ...rest } = summary;
  return rest;
}

async function currentConfirmationNo(deps: LayoutDeps, uploadId: string): Promise<number | "unavailable"> {
  const r = await readCurrentLayoutConfirmation(deps.db, uploadId);
  return r.kind === "unavailable" ? "unavailable" : r.confirmation?.confirmation_no ?? 0;
}

export async function handleLayoutRequest(userId: string, body: unknown, deps: LayoutDeps): Promise<LayoutResponse> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  switch (b.action) {
    case "inspect": {
      const opened = await openUpload(deps, userId, b.uploadId);
      if (!opened.ok) return opened.response;
      const current = await currentConfirmationNo(deps, opened.upload.id);
      if (current === "unavailable") return unavailable();
      const tables = readSourceTables(opened.bytes, opened.upload.file_name ?? "", deps.xlsx);
      if (!tables.ok) return { status: 200, body: { status: "unreadable", issue: tables.issue, sourceFileHash: opened.sourceFileHash, currentConfirmationNo: current } };
      const sheets = tables.sheets.map((s) => {
        const detection = detectColumns(s.rows, opened.upload.period_year ?? null);
        const amountCols = detection.map ? [detection.map.debit, detection.map.credit, detection.map.balance].filter((x): x is number => x !== null) : [];
        // Evidence from the amount columns the automatic reading found; when it found none (custom headers), from every
        // amount-like text cell below the first row — never "no evidence" read as "unambiguous".
        const amountCells = detection.map && amountCols.length > 0
          ? s.rows.slice(detection.map.headerIndex + 1).flatMap((r) => amountCols.map((c) => r.cells[c])).filter(isAmountText)
          : s.rows.slice(1).flatMap((r) => r.cells).filter(isAmountText);
        return {
          name: tables.kind === "csv" ? null : s.name,
          rowCount: s.rows.length,
          preview: s.rows.slice(0, PREVIEW_ROWS).map((r) => ({ rowNumber: r.rowNumber, cells: r.cells.slice(0, PREVIEW_COLUMNS).map(cellText) })),
          suggestion: detection.map ? { headerRow: detection.map.headerRowNumber, columns: detection.detected } : null,
          numberFormats: numberFormatEvidence(amountCells),
        };
      });
      return { status: 200, body: { status: "ok", kind: tables.kind, sourceFileHash: opened.sourceFileHash, currentConfirmationNo: current, sheets, numberFormats: Object.fromEntries(Object.entries(NUMBER_FORMATS).map(([k, f]) => [k, f.example])) } };
    }
    case "validate": {
      const opened = await openUpload(deps, userId, b.uploadId);
      if (!opened.ok) return opened.response;
      const v = await validateOn(deps, opened, b.layout);
      if (!v.ok) return v.response;
      return { status: 200, body: { status: "validated", report: v.report as unknown as Record<string, unknown> } };
    }
    case "confirm": {
      const expected = b.expectedConfirmationNo;
      if (!Number.isInteger(expected) || (expected as number) < 0) return bad("expectedConfirmationNo must be the confirmation number you saw (0 when there was none).");
      const templateId = b.templateId ?? null;
      if (templateId !== null && (typeof templateId !== "string" || !UUID.test(templateId))) return bad("templateId must be a UUID.");
      const opened = await openUpload(deps, userId, b.uploadId);
      if (!opened.ok) return opened.response;
      const v = await validateOn(deps, opened, b.layout);
      if (!v.ok) return v.response;
      if (!v.report.layoutFits) return { ...refusal("LAYOUT_DOES_NOT_FIT"), body: { ...refusal("LAYOUT_DOES_NOT_FIT").body, report: v.report } };
      // Several plausible number formats that give different values: never a silent choice. The person must have seen the
      // ambiguity and confirmed the declared format explicitly (the whole file was just validated under it).
      if (v.report.numberFormats?.ambiguous && b.numberFormatConfirmed !== true) {
        return { ...refusal("NUMBER_FORMAT_AMBIGUOUS"), body: { ...refusal("NUMBER_FORMAT_AMBIGUOUS").body, report: v.report } };
      }
      const { rows, ...summary } = v.report;
      const { data, error } = await deps.rpc("layout_record_confirmation", {
        p_user_id: userId, p_upload_id: opened.upload.id, p_expected_confirmation_no: expected,
        p_source_file_hash: opened.sourceFileHash, p_profile: v.profile, p_profile_sha256: v.report.profileSha256,
        p_resolved_profile: v.report.resolved, p_resolved_profile_sha256: v.report.resolvedProfileSha256,
        p_template_id: templateId, p_validation: validationSummary(summary), p_row_dispositions: rows,
      });
      if (isMissingFunction(error) || isMissingRelation(error)) return unavailable();
      if (error) throw new Error(`layout_record_confirmation failed: ${error.code ?? "unknown"}`);
      const answer = data as { outcome: string; code?: string; confirmationId?: string; confirmationNo?: number; currentConfirmationNo?: number; replay?: boolean; unchanged?: boolean };
      if (answer.outcome !== "confirmed") return refusal(answer.code ?? "REFUSED", answer.currentConfirmationNo !== undefined ? { currentConfirmationNo: answer.currentConfirmationNo } : {});
      return { status: 200, body: { status: "confirmed", confirmationId: answer.confirmationId, confirmationNo: answer.confirmationNo, replay: !!answer.replay, unchanged: !!answer.unchanged, report: v.report as unknown as Record<string, unknown> } };
    }
    case "save_template": {
      if (typeof b.companyId !== "string" || !UUID.test(b.companyId)) return bad("companyId must be a UUID.");
      if (typeof b.templateKey !== "string" || !UUID.test(b.templateKey)) return bad("templateKey must be a UUID.");
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad("expectedVersion must be the version you saw (0 for a new template).");
      if (typeof b.name !== "string" || b.name.trim() === "" || b.name.length > 120) return bad("Give the template a name (up to 120 characters).");
      const v = validateProfile(b.layout);
      if (!v.ok) return bad("The layout is incomplete.", v.errors);
      const { data, error } = await deps.rpc("layout_save_template", {
        p_user_id: userId, p_company_id: b.companyId, p_template_key: b.templateKey, p_expected_version: b.expectedVersion,
        p_name: b.name, p_profile: v.profile, p_profile_sha256: await profileSha256(v.profile),
      });
      if (isMissingFunction(error) || isMissingRelation(error)) return unavailable();
      if (error) throw new Error(`layout_save_template failed: ${error.code ?? "unknown"}`);
      const answer = data as { outcome: string; code?: string; templateId?: string; templateKey?: string; version?: number; currentVersion?: number; replay?: boolean; unchanged?: boolean };
      if (answer.outcome !== "saved") return refusal(answer.code ?? "REFUSED", answer.currentVersion !== undefined ? { currentVersion: answer.currentVersion } : {});
      return { status: 200, body: { status: "saved", templateId: answer.templateId, templateKey: answer.templateKey, version: answer.version, replay: !!answer.replay, unchanged: !!answer.unchanged } };
    }
    default:
      return bad("action must be inspect, validate, confirm or save_template.");
  }
}

