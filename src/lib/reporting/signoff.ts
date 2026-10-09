// reporting/signoff.ts — the reporting workbench's server calls for report versions, readiness and sign-off.
//
// Reads are RPCs and RLS-scoped selects. The ONLY writes are the existing canonical server functions:
//   fs_commit_revision          one atomic call: evidence batches + the immutable report version + its evaluation
//   fs_set_publication_state    the one sign-off path (REVIEWED needs review_close; FINAL needs approve_certification)
// No table is written from the browser, no actor id is sent, and nothing here decides readiness: the server's
// fs_report_readiness (with fs_publication_blockers v2) is the authority, and its blockers are shown as returned.

import { z } from "zod";
import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import type { CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import type { ReportingDependenciesRef } from "@/lib/statements/canonicalDocument";

export interface ReportingDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  select(table: string, filters: Record<string, string | number | boolean>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

/** A refusal from the server, kept with its code so the page can say what to do next. */
export class ServerRefusal extends Error {
  constructor(readonly fn: string, message: string, readonly code: string | null) { super(message); }
}

const HEX = z.string().regex(/^[0-9a-f]{64}$/);
const dependenciesSchema = z.object({
  state: z.string(), dependenciesSha256: HEX.optional(), compositionSha256: HEX.optional(),
  notesStatusSha256: HEX.nullable().optional(), comparativeStatusSha256: HEX.nullable().optional(), blockers: z.array(z.string()).default([]),
});
export type ReportingDependencies = z.infer<typeof dependenciesSchema>;
const versionSchema = z.object({
  reportId: z.string(), reportVersion: z.number().int(), createdAt: z.string(), creatorRole: z.string().nullable(), creatorRef: z.string(),
  contentHash: z.string(), evidenceBatchIds: z.array(z.string()), state: z.enum(["DRAFT", "REVIEWED", "FINAL"]), isLatest: z.boolean(),
});
export type SavedVersion = z.infer<typeof versionSchema>;
const readinessSchema = z.object({ ready: z.boolean(), blockers: z.array(z.string()) }).passthrough();
export type Readiness = z.infer<typeof readinessSchema>;
const datesSchema = z.object({ reportingStart: z.string().nullable(), reportingEnd: z.string().nullable() }).passthrough();
const inputSchema = z.object({ state: z.string(), current: datesSchema.optional(), comparative: datesSchema.nullable().optional() }).passthrough();
export type ReportingInput = z.infer<typeof inputSchema>;

export function dependenciesRef(d: ReportingDependencies): ReportingDependenciesRef | null {
  if (d.state !== "current" || !d.dependenciesSha256 || !d.compositionSha256) return null;
  return { dependenciesSha256: d.dependenciesSha256, compositionSha256: d.compositionSha256, notesStatusSha256: d.notesStatusSha256 ?? null, comparativeStatusSha256: d.comparativeStatusSha256 ?? null };
}

/** The evidence batch as the commit path takes it (the same shape the existing workspace sends). */
export function evidencePayload(batch: EvidenceBatch, expectedPreviousBatchId: string | null) {
  return {
    evidenceBatchId: batch.evidenceBatchId, reportingPeriodId: batch.reportingPeriodId, evidenceType: batch.evidenceType, periodRole: batch.periodRole,
    seriesKey: batch.seriesKey, schemaVersion: batch.schemaVersion, sourceFileName: batch.sourceFileName, contentHash: batch.contentHash,
    currency: batch.currency, scale: batch.scale, batchDocument: batch.document, validationStatus: batch.validationStatus, diagnostics: batch.diagnostics,
    expectedPreviousBatchId,
  };
}

/** A stored evidence row read back as a batch (latest version of each series is what a report uses). */
export interface StoredEvidence { readonly batch: EvidenceBatch; readonly version: number; readonly supersedesBatchId: string | null }
function toStoredEvidence(r: Record<string, unknown>): StoredEvidence {
  return {
    version: Number(r.version), supersedesBatchId: r.supersedes_batch_id == null ? null : String(r.supersedes_batch_id),
    batch: {
      evidenceBatchId: String(r.evidence_batch_id), companyId: String(r.company_id), evidenceType: String(r.evidence_type) as EvidenceBatch["evidenceType"],
      periodRole: String(r.period_role) as EvidenceBatch["periodRole"], reportingPeriodId: String(r.reporting_period_id), seriesKey: String(r.series_key),
      schemaVersion: String(r.schema_version ?? "1"), sourceFileName: r.source_file_name == null ? null : String(r.source_file_name),
      contentHash: String(r.content_hash), replayIdentity: String(r.replay_identity), currency: r.currency == null ? null : String(r.currency),
      scale: r.scale == null ? null : Number(r.scale), document: r.batch_document as EvidenceBatch["document"],
      diagnostics: (r.diagnostics ?? []) as EvidenceBatch["diagnostics"], validationStatus: String(r.validation_status) as EvidenceBatch["validationStatus"],
    },
  };
}

/** Latest version of each (type, role, series). */
export function latestEvidence(rows: readonly StoredEvidence[]): StoredEvidence[] {
  const best = new Map<string, StoredEvidence>();
  for (const r of rows) {
    const k = `${r.batch.evidenceType}|${r.batch.periodRole}|${r.batch.seriesKey}`;
    const cur = best.get(k);
    if (!cur || r.version > cur.version) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => (a.batch.evidenceBatchId < b.batch.evidenceBatchId ? -1 : 1));
}

/** JSON the database stores: bigint as the canonical serialisation writes it. */
const asJson = (v: unknown): unknown => JSON.parse(canonicalStringify(v));

export function signoffClient(db: ReportingDb) {
  const rpc = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new ServerRefusal(fn, error.message, error.code ?? null);
    return data;
  };
  const rows = async (table: string, filters: Record<string, string | number | boolean>) => {
    const { data, error } = await db.select(table, filters);
    if (error) throw new ServerRefusal(table, error.message, error.code ?? null);
    return (data ?? []) as Record<string, unknown>[];
  };
  return {
    dependencies: async (companyId: string, periodYear: number) => dependenciesSchema.parse(await rpc("fs_reporting_dependencies", { p_company_id: companyId, p_period_year: periodYear })),
    input: async (companyId: string, periodYear: number) => inputSchema.parse(await rpc("fs_reporting_input", { p_company_id: companyId, p_period_year: periodYear })),
    versions: async (companyId: string, periodYear: number) => z.array(versionSchema).parse(await rpc("fs_list_saved_versions", { p_company_id: companyId, p_period_year: periodYear })),
    readiness: async (companyId: string, reportId: string, reportVersion: number) => readinessSchema.parse(await rpc("fs_report_readiness", { p_company_id: companyId, p_report_id: reportId, p_report_version: reportVersion })),
    evidence: async (companyId: string, reportingPeriodId: string) => (await rows("financial_evidence_batches", { company_id: companyId, reporting_period_id: reportingPeriodId })).map(toStoredEvidence),
    disclosureTexts: async (companyId: string, periodYear: number) => (await rows("fs_disclosure_texts", { company_id: companyId, period_year: periodYear }))
      .filter((r) => r.body != null).map((r) => ({ requirementId: String(r.requirement_id), textId: String(r.id), body: String(r.body), sourceRef: r.source_ref == null ? null : String(r.source_ref) })),
    /** The stored document of a version, exactly as saved. */
    report: async (reportId: string, reportVersion: number) => {
      const r = (await rows("financial_statement_reports", { report_id: reportId, report_version: reportVersion }))[0];
      return r ? { document: r.report_document as Record<string, unknown>, contentHash: String(r.content_hash), createdAt: String(r.created_at) } : null;
    },
    publications: async (reportId: string) => (await rows("financial_statement_publications", { report_id: reportId }))
      .map((r) => ({ reportVersion: Number(r.report_version), state: String(r.state), createdAt: String(r.created_at), seq: Number(r.seq) }))
      .sort((a, b) => a.seq - b.seq),
    bindings: async (reportId: string) => (await rows("fs_publication_bindings", { report_id: reportId }))
      .map((r) => ({ reportVersion: Number(r.report_version), state: String(r.state), documentSha256: String(r.document_sha256), dependenciesSha256: String(r.dependencies_sha256),
        // The authenticated approver as recorded at approval (20261022100000); null on a binding recorded before it.
        approverFirmMemberId: r.approver_firm_member_id == null ? null : String(r.approver_firm_member_id), approverRole: r.approver_role == null ? null : String(r.approver_role),
        approverDisplayName: r.approver_display_name == null ? null : String(r.approver_display_name), approvedAt: r.approved_at == null ? null : String(r.approved_at) })),
    /** One atomic server call: new evidence + the new immutable version + its evaluation (or nothing). */
    commit: async (p: {
      companyId: string; reportId: string; expectedReportVersion: number; idempotencyKey: string; report: CanonicalFinancialStatementReport; contentHash: string;
      newEvidence: readonly { batch: EvidenceBatch; expectedPreviousBatchId: string | null }[]; evidenceBatchIds: readonly string[];
      evaluation: { evaluationRunId: string; rulePackId: string; rulePackVersion: string; engineVersion: string; inputHash: string; findings: unknown };
    }) => {
      const row = (await rpc("fs_commit_revision", {
        p_company_id: p.companyId, p_report_id: p.reportId, p_expected_report_version: p.expectedReportVersion, p_idempotency_key: p.idempotencyKey,
        p_period_year: p.report.period.periodYear, p_provenance_origin: p.report.provenanceOrigin, p_report_document: asJson(p.report), p_content_hash: p.contentHash,
        p_evidence: p.newEvidence.map((e) => evidencePayload(e.batch, e.expectedPreviousBatchId)), p_evidence_batch_ids: [...p.evidenceBatchIds],
        p_evaluation: { ...p.evaluation, findings: asJson(p.evaluation.findings) },
      })) as Record<string, unknown>;
      // An exact replay returns the stored version (the same number a new save would get): callers count versions, never infer.
      return { reportVersion: Number(row.report_version) };
    },
    setState: async (companyId: string, reportId: string, reportVersion: number, state: "REVIEWED" | "FINAL", reason: string) =>
      (await rpc("fs_set_publication_state", { p_report_id: reportId, p_report_version: reportVersion, p_company_id: companyId, p_state: state, p_reason: reason })) as Record<string, unknown>,
  };
}
export type SignoffClient = ReturnType<typeof signoffClient>;

/**
 * How a recorded approver is named: the display name on record at approval; without one, the role and the stable
 * membership reference — never a guessed or current name.
 */
export function approverText(b: { approverDisplayName: string | null; approverRole: string | null; approverFirmMemberId: string | null }): string {
  if (b.approverDisplayName) return b.approverRole ? `${b.approverDisplayName} (${b.approverRole})` : b.approverDisplayName;
  if (b.approverFirmMemberId) return `${b.approverRole ?? "member"} ${b.approverFirmMemberId.slice(0, 8)} (no name on record)`;
  return "approver not recorded (signed before approver recording)";
}
