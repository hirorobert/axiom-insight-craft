// reporting/prepareVersion.ts — saves the next report version through the ONE atomic commit path, resumably.
//
// Every authority is read fresh from the server (composition, notes, dependencies, reporting input, evidence, recorded
// wording, reviewed cash accounts); the document is assembled deterministically (financialGeneration/composedReport),
// evaluated with the canonical rule pack, and committed — evidence + version + evaluation — in one server call. Nothing is
// written when an authority is not current, and readiness is never decided here: the server does that afterwards.
//
// Stored evidence is itself a dependency (the notes status reads it), so a save that brings NEW evidence takes two steps:
//   1. the EVIDENCE step stores the new batches with a version built on the dependencies as they were before them; that
//      version is then stale (REPORTING_DEPENDENCIES_STALE) and can never be signed;
//   2. the BIND step saves the next version on the dependencies as they are now. Only it can be signed.
// The pair is RESUMABLE and IDEMPOTENT, whatever fails in between and however often it is retried:
//   - each step's idempotency key is the attempt's key plus the step and the version it builds on, so an exact retry
//     replays the step and a retry after someone else saved builds on the newer version instead of conflicting;
//   - evidence the server already holds (same deterministic batch id) is never sent again, so it is never duplicated;
//   - when the latest version is already bound to the current dependencies and no evidence is outstanding, that version
//     is returned and nothing is written.

import { assembleComposedReport, evaluateComposedReport, reportContentHash } from "@/lib/financialGeneration/composedReport";
import type { GenerationDiagnostic } from "@/lib/financialGeneration/common";
import type { EvidenceUse } from "@/lib/financialGeneration/applyEvidence";
import { cashScopeFromReportingInput } from "./cashScope";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { parseComposition } from "@/lib/statements/composition";
import { parseNotesStatus, type NotesStatus, type NotesStatusResult } from "@/lib/notes/notesStatus";
import { dependenciesRef, latestEvidence, type ReportingDb, type SignoffClient } from "./signoff";

export type PrepareOutcome =
  | { readonly outcome: "saved"; readonly reportId: string; readonly reportVersion: number; readonly diagnostics: readonly GenerationDiagnostic[]; readonly use: readonly EvidenceUse[];
      /** Set when this call stored new evidence with its own (stale, never signable) version, superseded by `reportVersion`. */
      readonly evidenceVersion?: number;
      /** True when the latest version was already bound to the current dependencies: nothing was written. */
      readonly alreadyCurrent?: boolean }
  | { readonly outcome: "refused"; readonly reason: string; readonly diagnostics: readonly GenerationDiagnostic[] };

export interface PrepareInput {
  readonly companyId: string;
  readonly periodYear: number;
  readonly legalName: string;
  /** The report lineage to extend; a new one is started when there is none for the period. */
  readonly reportId: string;
  /** Newly supplied evidence (parsed in the browser by financialEvidence/intake); stored atomically with a version. */
  readonly newEvidence: readonly EvidenceBatch[];
  /** One per attempt, kept across its retries. */
  readonly idempotencyKey: string;
  /** Captured once with the key: the evaluation's timestamp is part of the committed content, so a retry repeats it. */
  readonly evaluatedAt: string;
}

const none: readonly GenerationDiagnostic[] = [];
const series = (b: EvidenceBatch) => `${b.evidenceType}|${b.periodRole}|${b.seriesKey}`;

export async function prepareReportVersion(db: ReportingDb, client: SignoffClient, p: PrepareInput): Promise<PrepareOutcome> {
  const stored0 = latestEvidence(await client.evidence(p.companyId, `FY${p.periodYear}`));
  const held = new Set(stored0.map((s) => s.batch.evidenceBatchId));
  const outstanding = p.newEvidence.filter((b) => !held.has(b.evidenceBatchId));

  let evidenceVersion: number | undefined;
  if (outstanding.length > 0) {
    const latest = await latestVersion(client, p);
    const step = await buildAndCommit(db, client, p, latest, outstanding, `${p.idempotencyKey}:evidence:${latest}`);
    if (step.outcome !== "saved") return step;
    evidenceVersion = step.reportVersion;
  }
  // The bind step: the latest version on the dependencies as they are now (resumes after any failure above or below).
  const latest = await latestVersion(client, p);
  const current = dependenciesRef(await client.dependencies(p.companyId, p.periodYear));
  if (latest > 0 && current) {
    const doc = (await client.report(p.reportId, latest))?.document as { reportingDependencies?: { dependenciesSha256?: string } } | undefined;
    if (doc?.reportingDependencies?.dependenciesSha256 === current.dependenciesSha256) {
      return { outcome: "saved", reportId: p.reportId, reportVersion: latest, diagnostics: none, use: [], ...(evidenceVersion !== undefined && evidenceVersion !== latest ? { evidenceVersion } : {}), alreadyCurrent: evidenceVersion === undefined };
    }
  }
  const bound = await buildAndCommit(db, client, p, latest, [], `${p.idempotencyKey}:bind:${latest}`);
  return bound.outcome === "saved" && evidenceVersion !== undefined ? { ...bound, evidenceVersion } : bound;
}

async function latestVersion(client: SignoffClient, p: PrepareInput): Promise<number> {
  const versions = await client.versions(p.companyId, p.periodYear);
  return versions.filter((v) => v.reportId === p.reportId).reduce((m, v) => Math.max(m, v.reportVersion), 0);
}

async function buildAndCommit(db: ReportingDb, client: SignoffClient, p: PrepareInput, expected: number, newEvidence: readonly EvidenceBatch[], key: string): Promise<PrepareOutcome> {
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
  // Each period's cash accounts come from that period's authoritative input, never the company's (DEFECT D-3).
  const cashScope = cashScopeFromReportingInput(input);
  if (!cashScope) return { outcome: "refused", reason: "The reporting input does not carry its accounts; the cash perimeter cannot be scoped.", diagnostics: none };
  const comparativeDates = cmp?.reportingStart && cmp.reportingEnd ? { start: cmp.reportingStart, end: cmp.reportingEnd } : null;

  const stored = latestEvidence(await client.evidence(p.companyId, `FY${p.periodYear}`));
  // New evidence replaces the stored version of the same series (the server checks the expected previous version).
  const replaced = new Set(newEvidence.map(series));
  const kept = stored.filter((s) => !replaced.has(series(s.batch)));
  const newWithPrev = newEvidence.map((b) => ({ batch: b, expectedPreviousBatchId: stored.find((s) => series(s.batch) === series(b))?.batch.evidenceBatchId ?? null }));
  const evidence = [...kept.map((s) => s.batch), ...newEvidence];

  const assembled = assembleComposedReport({
    reportId: p.reportId, reportVersion: expected + 1, companyId: p.companyId, legalName: p.legalName, composition,
    currentDates: { start: cur.reportingStart, end: cur.reportingEnd }, comparativeDates, dependencies: ref, notes,
    disclosures: await client.disclosureTexts(p.companyId, p.periodYear), evidence, cashScope,
  });
  if (!assembled.report) return { outcome: "refused", reason: "The evidence does not yet form a valid report; see the diagnostics.", diagnostics: assembled.diagnostics };
  const evaluation = evaluateComposedReport(assembled.report, () => p.evaluatedAt);
  // The version references every usable batch it was built from (the server checks each is current and valid). New
  // evidence the report does not use is not stored: it would bind nothing.
  const used = [...new Set(assembled.use.filter((u) => u.used).map((u) => u.evidenceBatchId))].sort();
  const saved = await client.commit({
    companyId: p.companyId, reportId: p.reportId, expectedReportVersion: expected, idempotencyKey: key,
    report: assembled.report, contentHash: reportContentHash(assembled.report), newEvidence: newWithPrev.filter((e) => used.includes(e.batch.evidenceBatchId)),
    evidenceBatchIds: used, evaluation,
  });
  return { outcome: "saved", reportId: p.reportId, reportVersion: saved.reportVersion, diagnostics: assembled.diagnostics, use: assembled.use };
}
