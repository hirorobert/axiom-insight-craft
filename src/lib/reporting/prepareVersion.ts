// reporting/prepareVersion.ts — saves the next report version through the ONE atomic commit path.
//
// Reads every authority fresh from the server (composition, notes, dependencies, reporting input, evidence, recorded
// wording, reviewed cash accounts), assembles the document deterministically (financialGeneration/composedReport),
// evaluates it with the canonical rule pack, and commits evidence + version + evaluation in one server call. It refuses
// before writing anything when an authority is not current, and it never decides readiness: the server does, afterwards.

import { assembleComposedReport, evaluateComposedReport, reportContentHash } from "@/lib/financialGeneration/composedReport";
import type { GenerationDiagnostic } from "@/lib/financialGeneration/common";
import type { EvidenceUse } from "@/lib/financialGeneration/applyEvidence";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { parseComposition } from "@/lib/statements/composition";
import { parseNotesStatus, type NotesStatus, type NotesStatusResult } from "@/lib/notes/notesStatus";
import { dependenciesRef, latestEvidence, type ReportingDb, type SignoffClient } from "./signoff";

export type PrepareOutcome =
  | { readonly outcome: "saved"; readonly reportId: string; readonly reportVersion: number; readonly diagnostics: readonly GenerationDiagnostic[]; readonly use: readonly EvidenceUse[];
      /** Set when new evidence changed the dependencies: the version that stored it, superseded by `reportVersion`. */
      readonly evidenceVersion?: number }
  | { readonly outcome: "refused"; readonly reason: string; readonly diagnostics: readonly GenerationDiagnostic[] };

export interface PrepareInput {
  readonly companyId: string;
  readonly periodYear: number;
  readonly legalName: string;
  /** The report lineage to extend; a new one is started when there is none for the period. */
  readonly reportId: string;
  readonly expectedReportVersion: number;
  /** Newly supplied evidence (parsed in the browser by financialEvidence/intake); stored atomically with the version. */
  readonly newEvidence: readonly EvidenceBatch[];
  /** Stable for one attempt: a retry with the same key and content is a replay, never a second version. */
  readonly idempotencyKey: string;
  /** Captured once with the key: the evaluation's timestamp is part of the committed content, so a retry repeats it. */
  readonly evaluatedAt: string;
}

export async function prepareReportVersion(db: ReportingDb, client: SignoffClient, p: PrepareInput): Promise<PrepareOutcome> {
  const none: readonly GenerationDiagnostic[] = [];
  const rpc = async (fn: string) => {
    const { data, error } = await db.rpc(fn, { p_company_id: p.companyId, p_period_year: p.periodYear });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const composition = parseComposition(await rpc("fs_statement_composition"));
  if (composition.state !== "composed") return { outcome: "refused", reason: `The statements are not composed (${composition.state}).`, diagnostics: none };
  const parsed: NotesStatusResult = parseNotesStatus(await rpc("fs_notes_status"));
  if (parsed.state !== "evaluated") return { outcome: "refused", reason: `The notes are not evaluated (${parsed.state}).`, diagnostics: none };
  const notes = parsed as NotesStatus;
  const deps = await client.dependencies(p.companyId, p.periodYear);
  const ref = dependenciesRef(deps);
  if (!ref) return { outcome: "refused", reason: `The reporting dependencies are not current (${deps.state}).`, diagnostics: none };
  if (ref.compositionSha256 !== composition.compositionSha256 || ref.notesStatusSha256 !== notes.statusSha256)
    return { outcome: "refused", reason: "The statements or notes changed while the version was being prepared; try again.", diagnostics: none };
  const input = await client.input(p.companyId, p.periodYear);
  const cur = input.current;
  if (!cur?.reportingStart || !cur.reportingEnd) return { outcome: "refused", reason: "The reporting period dates are not recorded.", diagnostics: none };
  const cmp = input.comparative;
  const comparativeDates = cmp?.reportingStart && cmp.reportingEnd ? { start: cmp.reportingStart, end: cmp.reportingEnd } : null;

  const periodId = `FY${p.periodYear}`;
  const stored = latestEvidence(await client.evidence(p.companyId, periodId));
  // New evidence replaces the stored version of the same series (the server checks the expected previous version).
  const series = (b: EvidenceBatch) => `${b.evidenceType}|${b.periodRole}|${b.seriesKey}`;
  const replaced = new Set(p.newEvidence.map(series));
  const kept = stored.filter((s) => !replaced.has(series(s.batch)));
  const newWithPrev = p.newEvidence.map((b) => ({ batch: b, expectedPreviousBatchId: stored.find((s) => series(s.batch) === series(b))?.batch.evidenceBatchId ?? null }));
  const evidence = [...kept.map((s) => s.batch), ...p.newEvidence];

  const assembled = assembleComposedReport({
    reportId: p.reportId, reportVersion: p.expectedReportVersion + 1, companyId: p.companyId, legalName: p.legalName, composition,
    currentDates: { start: cur.reportingStart, end: cur.reportingEnd }, comparativeDates, dependencies: ref, notes,
    disclosures: await client.disclosureTexts(p.companyId, p.periodYear), evidence, cashAccountKeys: await client.cashAccountKeys(p.companyId),
  });
  if (!assembled.report) return { outcome: "refused", reason: "The evidence does not yet form a valid report; see the diagnostics.", diagnostics: assembled.diagnostics };
  const evaluation = evaluateComposedReport(assembled.report, () => p.evaluatedAt);
  // The version references every usable batch it was built from (the server checks each is current and valid).
  const used = [...new Set(assembled.use.filter((u) => u.used).map((u) => u.evidenceBatchId))].sort();
  const saved = await client.commit({
    companyId: p.companyId, reportId: p.reportId, expectedReportVersion: p.expectedReportVersion, idempotencyKey: p.idempotencyKey,
    report: assembled.report, contentHash: reportContentHash(assembled.report), newEvidence: newWithPrev.filter((e) => used.includes(e.batch.evidenceBatchId)),
    evidenceBatchIds: used, evaluation,
  });
  // Stored evidence is itself a dependency (the notes status reads it), so a version that brings new evidence is bound to
  // the dependencies as they were BEFORE that evidence existed. When they moved, the next version is saved at once on the
  // current dependencies; both versions are kept (history is immutable), and only the latter can be signed.
  if (p.newEvidence.length > 0) {
    const after = dependenciesRef(await client.dependencies(p.companyId, p.periodYear));
    if (after && after.dependenciesSha256 !== ref.dependenciesSha256) {
      const next = await prepareReportVersion(db, client, { ...p, expectedReportVersion: saved.reportVersion, newEvidence: [], idempotencyKey: `${p.idempotencyKey}/rebind` });
      return next.outcome === "saved" ? { ...next, evidenceVersion: saved.reportVersion } : next;
    }
  }
  return { outcome: "saved", reportId: p.reportId, reportVersion: saved.reportVersion, diagnostics: assembled.diagnostics, use: assembled.use };
}
