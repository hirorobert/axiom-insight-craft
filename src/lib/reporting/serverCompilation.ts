/** Trusted-runtime entry point. All inputs are read through the authenticated server transport.
 * The request names a saved version only. No submitted document, findings or VALID flag is authoritative.
 * The browser and this compiler use the same generators, evidence schemas and rule pack. */
import { assembleComposedReport, evaluateComposedReport, reportContentHash } from "@/lib/financialGeneration/composedReport";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { ingestRecords } from "@/lib/financialEvidence/intake";
import { EVIDENCE_TYPES, EVIDENCE_SCHEMA_VERSION, type EvidenceBatch } from "@/lib/financialEvidence/types";
import { parseComposition, type Composition } from "@/lib/statements/composition";
import { parseNotesStatus, type NotesStatus } from "@/lib/notes/notesStatus";
import { dependenciesRef, toStoredEvidence, type ReportingDb } from "./signoff";
import { cashScopeFromReportingInput } from "./cashScope";

export const STATEMENT_COMPILER_VERSION = "financial-report-compiler/1";
export interface CompileRequest { companyId: string; reportId: string; reportVersion: number }
export class CompilationRefusal extends Error {}
function refuse(message: string): never { throw new CompilationRefusal(message); }

/** Revalidates persisted source records, rather than the preparer's validation assertion. Original provenance is kept. */
export function validateStoredEvidence(batch: EvidenceBatch, dates: { start: string; end: string }): EvidenceBatch {
  const d = batch.document;
  if (!EVIDENCE_TYPES.includes(batch.evidenceType) || batch.evidenceType === "TRIAL_BALANCE" || batch.evidenceType === "EXTRACTED_CANDIDATES"
      || batch.schemaVersion !== EVIDENCE_SCHEMA_VERSION || d?.schemaVersion !== EVIDENCE_SCHEMA_VERSION
      || d.evidenceType !== batch.evidenceType || d.periodRole !== batch.periodRole || d.reportingPeriodId !== batch.reportingPeriodId
      || d.seriesKey !== batch.seriesKey || d.currency !== batch.currency || d.scale !== (batch.scale === null ? null : String(batch.scale))
      || !Array.isArray(d.columns) || !d.columns.every(c => typeof c === "string") || !Array.isArray(d.rows)
      || !d.rows.every(r => Array.isArray(r) && r.every(c => typeof c === "string"))) refuse("SERVER_EVIDENCE_SCHEMA_INVALID");
  const parsed = ingestRecords({ companyId: batch.companyId, evidenceType: batch.evidenceType, periodRole: batch.periodRole,
    reportingPeriodId: batch.reportingPeriodId, seriesKey: batch.seriesKey, currency: batch.currency ?? undefined,
    scale: batch.scale ?? undefined, periodStart: dates.start, periodEnd: dates.end }, [d.columns, ...d.rows],
    { contentHash: batch.contentHash, format: d.sourceFormat ?? "CSV" });
  if (parsed.outcome !== "PARSED" || !["VALID", "VALID_WITH_WARNINGS"].includes(parsed.batch.validationStatus)) refuse("SERVER_EVIDENCE_INVALID:" + batch.evidenceBatchId);
  // Reading a source is not rewriting it. Its original row locators, file identity and parse provenance stay immutable.
  return { ...batch, validationStatus: parsed.batch.validationStatus, diagnostics: parsed.batch.diagnostics };
}

export async function compileSavedReport(db: ReportingDb, request: CompileRequest) {
  const source = await db.rpc("fs_server_compile_input", { p_company_id: request.companyId, p_report_id: request.reportId, p_report_version: request.reportVersion });
  if (source.error) refuse(source.error.message);
  const snapshot = source.data as { saved: Record<string, unknown>; composition: unknown; notes: unknown; dependencies: Parameters<typeof dependenciesRef>[0];
    input: { state: string; inputSha256?: string; current?: { reportingStart: string; reportingEnd: string }; comparative?: { reportingStart: string; reportingEnd: string } };
    evidence: Record<string, unknown>[]; disclosures: Parameters<typeof assembleComposedReport>[0]["disclosures"]; companyName: string };
  const saved = snapshot?.saved; if (!saved || saved.company_id !== request.companyId || saved.report_id !== request.reportId || saved.report_version !== request.reportVersion) refuse("REPORT_VERSION_NOT_FOUND");
  const composition = parseComposition(snapshot.composition); const parsedNotes = parseNotesStatus(snapshot.notes);
  const ref = dependenciesRef(snapshot.dependencies);
  if (composition.state !== "composed" || parsedNotes.state !== "evaluated" || !ref) refuse("SERVER_SOURCES_NOT_CURRENT");
  const c = composition as Composition; const notes = parsedNotes as NotesStatus;
  if (c.pack.packId !== "ifrs-for-smes/2015") refuse("FRAMEWORK_EDITION_UNSUPPORTED");
  if (ref.compositionSha256 !== c.compositionSha256 || ref.notesStatusSha256 !== notes.statusSha256) refuse("SERVER_SOURCES_CHANGED");
  const input = snapshot.input; const cur = input.current; const cmp = input.comparative;
  const cashScope = cashScopeFromReportingInput(input);
  if (input.state !== "current" || !cur?.reportingStart || !cur.reportingEnd || !cashScope || typeof snapshot.companyName !== "string") refuse("SERVER_SOURCES_NOT_CURRENT");
  if (input.inputSha256 !== c.inputSha256) refuse("SERVER_SOURCES_CHANGED");
  const doc = saved.report_document as Record<string, unknown>;
  if (saved.provenance_origin !== "TRIAL_BALANCE_DERIVED" || (doc?.framework as { kind?: string })?.kind !== "IFRS_FOR_SMES") refuse("PUBLICATION_PATH_UNSUPPORTED");
  const ids = saved.evidence_batch_ids as string[];
  if (!Array.isArray(ids) || !Array.isArray(snapshot.evidence)) refuse("SERVER_EVIDENCE_BINDING_INVALID");
  const stored = snapshot.evidence.map(toStoredEvidence);
  const evidence = ids.map(id => {
    const s = stored.find(s => s.batch.evidenceBatchId === id); if (!s) refuse("EVIDENCE_SUPERSEDED_OR_MISSING:" + id);
    const b = s.batch; const p = b.periodRole === "CURRENT" ? cur : cmp;
    if (b.companyId !== request.companyId || !p?.reportingStart || !p.reportingEnd) refuse("SERVER_EVIDENCE_PERIOD_INVALID");
    return validateStoredEvidence(b, { start: p.reportingStart, end: p.reportingEnd });
  });
  const result = assembleComposedReport({ reportId: request.reportId, reportVersion: request.reportVersion, companyId: request.companyId,
    legalName: snapshot.companyName, composition: c, currentDates: { start: cur.reportingStart, end: cur.reportingEnd },
    comparativeDates: cmp?.reportingStart && cmp.reportingEnd ? { start: cmp.reportingStart, end: cmp.reportingEnd } : null,
    dependencies: ref, notes, disclosures: snapshot.disclosures, evidence, cashScope });
  if (!result.report) refuse("SERVER_REPORT_CANNOT_COMPILE");
  const canonical = JSON.parse(canonicalStringify(result.report));
  const evaluation = evaluateComposedReport(result.report, () => String(saved.created_at));
  const match = reportContentHash(result.report) === sha256Hex(canonicalStringify(doc));
  // The receipt writer rechecks the snapshot's dependency identity under the lineage lock after computation.
  return { compilerVersion: STATEMENT_COMPILER_VERSION, documentHash: String(saved.document_hash), dependenciesHash: ref.dependenciesSha256,
    canonicalDocument: canonical, evaluation: JSON.parse(canonicalStringify(evaluation)), matches: match };
}
