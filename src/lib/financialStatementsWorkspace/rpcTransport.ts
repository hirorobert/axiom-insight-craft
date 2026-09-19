// financialStatementsWorkspace/rpcTransport.ts — the typed client for the
// financial-statements persistence RPCs (migration 20260919110000).
//
// Why RPCs and no Edge Function: every write is a SECURITY DEFINER function that
// derives the acting firm member from the caller's own JWT (auth.uid()), checks
// accepted non-viewer membership and the server-side rollout, and is granted to
// `authenticated` only. Nothing here needs a service-role secret, and none is
// reachable from this module: it speaks only through an injected RpcBackend that
// is the caller's own RLS-scoped session.
//
// The client never sends an actor id (no argument below carries one) and never
// trusts its own view of a version: the server compares and answers PT409.
// Documents contain no JSON number for money: canonicalStringify renders bigint
// minor units as {"__bigint__": "..."}.
//
// This module holds NO supabase import — that lives in supabaseFsBackend.ts, the
// single adapter — so the transport is testable against a fake or a disposable
// PostgreSQL without any hosted project.

import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import type { CanonicalFinancialStatementReport, ReviewerDecision, RuleEvaluationRecord } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch, EvidenceDiagnostic } from "@/lib/financialEvidence/types";
import { deserializeReport } from "./persistenceContract";

export interface RpcError {
  readonly code?: string;
  readonly message: string;
}

export interface FsBackend {
  rpc(fn: string, args: Readonly<Record<string, unknown>>): Promise<{ readonly data: unknown; readonly error: RpcError | null }>;
  select(table: FsTable, filters: Readonly<Record<string, string | number>>): Promise<{ readonly data: readonly Record<string, unknown>[] | null; readonly error: RpcError | null }>;
}

export type FsTable =
  | "financial_evidence_batches"
  | "financial_statement_reports"
  | "financial_statement_evaluations"
  | "financial_statement_reviewer_decisions"
  | "financial_statement_correction_groups"
  | "financial_statement_publications";

export type FsErrorKind = "FEATURE_DISABLED" | "FORBIDDEN" | "STALE_VERSION" | "REPLAY_CONFLICT" | "NOT_FOUND" | "INVALID" | "BLOCKED" | "NOT_EVALUATED" | "CONFLICT" | "UNKNOWN";

export class FsTransportError extends Error {
  constructor(readonly kind: FsErrorKind, message: string, readonly code?: string) {
    super(message);
    this.name = "FsTransportError";
  }
  /** True when re-reading server state and trying again could succeed. */
  get isConflict(): boolean {
    return this.kind === "STALE_VERSION" || this.kind === "REPLAY_CONFLICT" || this.kind === "CONFLICT";
  }
}

/** Maps a PostgREST/Postgres error to a typed transport error. Unrecognised failures are UNKNOWN, never success. */
export function mapRpcError(e: RpcError): FsTransportError {
  const m = e.message ?? "";
  const kind: FsErrorKind =
    e.code === "PT403" || /^FEATURE_DISABLED/.test(m) ? "FEATURE_DISABLED"
    : e.code === "42501" || /^FORBIDDEN|permission denied/i.test(m) ? "FORBIDDEN"
    : /^STALE_(REPORT_)?VERSION/.test(m) ? "STALE_VERSION"
    : /^REPLAY_CONFLICT/.test(m) ? "REPLAY_CONFLICT"
    : /^NOT_EVALUATED/.test(m) ? "NOT_EVALUATED"
    : /^BLOCKED/.test(m) ? "BLOCKED"
    : /^CONFLICT/.test(m) ? "CONFLICT"
    : e.code === "P0002" || /^NOT_FOUND/.test(m) ? "NOT_FOUND"
    : e.code === "22023" || /^INVALID/.test(m) ? "INVALID"
    : e.code === "PT409" || e.code === "23505" ? "CONFLICT"
    : "UNKNOWN";
  return new FsTransportError(kind, m, e.code);
}

const json = (value: unknown): unknown => JSON.parse(canonicalStringify(value));

export interface WorkspaceAccess {
  readonly enabled: boolean;
  readonly reason: "ENABLED" | "NOT_A_MEMBER" | "KILL_SWITCH" | "NOT_ALLOWLISTED" | "UNKNOWN";
}

export interface StoredReportRow {
  readonly report: CanonicalFinancialStatementReport;
  readonly reportVersion: number;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly companyId: string;
  /** The evidence versions this report version was composed from. */
  readonly evidenceBatchIds: readonly string[];
}

/** One saved report version as listed to a company member: who (role + an opaque, stable reference), when, and its state. */
export interface SavedVersionSummary {
  readonly reportId: string;
  readonly reportVersion: number;
  readonly createdAt: string;
  readonly creatorRole: string;
  readonly creatorRef: string;
  readonly contentHash: string;
  readonly evidenceBatchIds: readonly string[];
  readonly state: "DRAFT" | "REVIEWED" | "FINAL";
  readonly isLatest: boolean;
}

export interface ReportReadiness {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export interface StoredEvaluationRow {
  readonly evaluationRunId: string;
  readonly reportVersion: number;
  readonly rulePackId: string;
  readonly rulePackVersion: string;
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly findings: readonly RuleEvaluationRecord[];
  readonly createdAt: string;
}

export interface StoredDecisionRow {
  readonly decisionId: string;
  readonly decision: ReviewerDecision;
  readonly reviewerFirmMemberId: string;
  readonly correctionGroupId: string | null;
  readonly seq: number;
}

export interface PublicationRow {
  readonly reportVersion: number;
  readonly state: "DRAFT" | "REVIEWED" | "FINAL";
  readonly reason: string;
  readonly createdAt: string;
  readonly seq: number;
}

export interface StoredEvidenceRow {
  readonly evidenceBatchId: string;
  readonly evidenceType: string;
  readonly periodRole: string;
  readonly reportingPeriodId: string;
  readonly seriesKey: string;
  readonly schemaVersion: string;
  readonly version: number;
  readonly validationStatus: string;
  readonly contentHash: string;
  readonly replayIdentity: string;
  readonly supersedesBatchId: string | null;
  readonly diagnostics: readonly EvidenceDiagnostic[];
  readonly document: unknown;
  readonly sourceFileName: string | null;
  readonly currency: string | null;
  readonly scale: number | null;
  readonly createdAt: string;
}

export interface CorrectionGroupInput {
  readonly groupId: string;
  readonly idempotencyKey: string;
  readonly companyId: string;
  readonly reportId: string;
  readonly expectedReportVersion: number;
  readonly steps: readonly {
    readonly reportVersion: number;
    readonly report: CanonicalFinancialStatementReport;
    /** A CORRECT_EVIDENCE step stores this corrected evidence version in the same transaction (and only such a step carries one). */
    readonly evidenceBatch?: EvidenceBatch;
    readonly expectedPreviousBatchId?: string;
    /** The evidence versions this step's report was composed from. */
    readonly evidenceBatchIds?: readonly string[];
  }[];
  readonly decisions: readonly ReviewerDecision[];
  readonly evaluation?: { readonly evaluationRunId: string; readonly rulePackId: string; readonly rulePackVersion: string; readonly engineVersion: string; readonly inputHash: string; readonly findings: readonly RuleEvaluationRecord[] };
}

export interface CommitRevisionInput {
  readonly companyId: string;
  readonly reportId: string;
  readonly expectedReportVersion: number;
  readonly idempotencyKey: string;
  /** The report at version expectedReportVersion + 1. */
  readonly report: CanonicalFinancialStatementReport;
  /** Evidence batches this revision ingests, each with the batch it supersedes (null for a new series). */
  readonly evidence: readonly { readonly batch: EvidenceBatch; readonly expectedPreviousBatchId: string | null }[];
  /** The evidence versions the report was composed from (every ingested batch must be among them). */
  readonly evidenceBatchIds: readonly string[];
  readonly evaluation: { readonly evaluationRunId: string; readonly rulePackId: string; readonly rulePackVersion: string; readonly engineVersion: string; readonly inputHash: string; readonly findings: readonly RuleEvaluationRecord[] };
}

function evidencePayload(batch: EvidenceBatch, expectedPreviousBatchId: string | null) {
  return {
    evidenceBatchId: batch.evidenceBatchId,
    reportingPeriodId: batch.reportingPeriodId,
    evidenceType: batch.evidenceType,
    periodRole: batch.periodRole,
    seriesKey: batch.seriesKey,
    schemaVersion: batch.schemaVersion,
    sourceFileName: batch.sourceFileName,
    contentHash: batch.contentHash,
    currency: batch.currency,
    scale: batch.scale,
    batchDocument: batch.document,
    validationStatus: batch.validationStatus,
    diagnostics: batch.diagnostics,
    expectedPreviousBatchId,
  };
}

export class FsRpcTransport {
  constructor(private readonly backend: FsBackend) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.backend.rpc(fn, args);
    if (error) throw mapRpcError(error);
    return data as T;
  }

  private async read(table: FsTable, filters: Record<string, string | number>): Promise<readonly Record<string, unknown>[]> {
    const { data, error } = await this.backend.select(table, filters);
    if (error) throw mapRpcError(error);
    return data ?? [];
  }

  async access(companyId: string): Promise<WorkspaceAccess> {
    try {
      const r = await this.call<{ enabled?: boolean; reason?: string } | null>("financial_statements_workspace_access", { p_company_id: companyId });
      const reason = (r?.reason ?? "UNKNOWN") as WorkspaceAccess["reason"];
      // Anything other than an explicit server "enabled: true" is a denial.
      return { enabled: r?.enabled === true, reason };
    } catch {
      return { enabled: false, reason: "UNKNOWN" };
    }
  }

  /**
   * The ONLY way evidence is accepted: one atomic call that stores the evidence batches, the immutable report version that
   * references them, the evaluation of that version and an audit event — or nothing. Exact replay (same idempotency key and
   * content) returns the stored version; the same key with different content, or a stale expected version, is refused.
   * Returns the version the server holds after the call (an unchanged revision reuses the latest version).
   */
  async commitRevision(input: CommitRevisionInput): Promise<{ readonly reportVersion: number; readonly created: boolean }> {
    const row = await this.call<Record<string, unknown>>("fs_commit_revision", {
      p_company_id: input.companyId,
      p_report_id: input.reportId,
      p_expected_report_version: input.expectedReportVersion,
      p_idempotency_key: input.idempotencyKey,
      p_period_year: input.report.period.periodYear,
      p_provenance_origin: input.report.provenanceOrigin,
      p_report_document: json(input.report),
      p_content_hash: contentHashOfDocument(input.report),
      p_evidence: input.evidence.map((e) => evidencePayload(e.batch, e.expectedPreviousBatchId)),
      p_evidence_batch_ids: [...input.evidenceBatchIds],
      p_evaluation: { ...input.evaluation, findings: json(input.evaluation.findings) },
    });
    const reportVersion = Number(row.report_version);
    return { reportVersion, created: reportVersion === input.expectedReportVersion + 1 };
  }

  async listEvidence(companyId: string, reportingPeriodId: string): Promise<readonly StoredEvidenceRow[]> {
    const rows = await this.read("financial_evidence_batches", { company_id: companyId, reporting_period_id: reportingPeriodId });
    return rows.map(toEvidenceRow).sort((a, b) => a.version - b.version || (a.createdAt < b.createdAt ? -1 : 1));
  }

  async saveReportVersion(report: CanonicalFinancialStatementReport, contentHash: string, evidenceBatchIds: readonly string[]): Promise<void> {
    await this.call("fs_save_report_version", {
      p_report_id: report.reportIdentity.reportId,
      p_report_version: report.reportIdentity.reportVersion,
      p_company_id: report.reportIdentity.companyId,
      p_period_year: report.period.periodYear,
      p_provenance_origin: report.provenanceOrigin,
      p_report_document: json(report),
      p_content_hash: contentHash,
      p_evidence_batch_ids: [...evidenceBatchIds],
    });
  }

  async saveEvaluation(input: { evaluationRunId: string; reportId: string; reportVersion: number; companyId: string; rulePackId: string; rulePackVersion: string; engineVersion: string; inputHash: string; findings: readonly RuleEvaluationRecord[] }): Promise<void> {
    await this.call("fs_save_evaluation", {
      p_evaluation_run_id: input.evaluationRunId,
      p_report_id: input.reportId,
      p_report_version: input.reportVersion,
      p_company_id: input.companyId,
      p_rule_pack_id: input.rulePackId,
      p_rule_pack_version: input.rulePackVersion,
      p_engine_version: input.engineVersion,
      p_input_hash: input.inputHash,
      p_findings: json(input.findings),
    });
  }

  /** The reviewer id is stripped: the server derives the actor from the authenticated session. */
  async appendDecision(reportId: string, companyId: string, decision: ReviewerDecision): Promise<void> {
    const { reviewerId: _discarded, ...withoutActor } = decision;
    await this.call("fs_append_decision", { p_decision_id: decision.decisionId, p_report_id: reportId, p_company_id: companyId, p_decision: json(withoutActor) });
  }

  async applyCorrectionGroup(input: CorrectionGroupInput): Promise<void> {
    await this.call("fs_apply_correction_group", {
      p_group_id: input.groupId,
      p_idempotency_key: input.idempotencyKey,
      p_company_id: input.companyId,
      p_report_id: input.reportId,
      p_expected_report_version: input.expectedReportVersion,
      p_steps: input.steps.map((s) => ({
        reportVersion: s.reportVersion,
        reportDocument: json(s.report),
        contentHash: contentHashOfDocument(s.report),
        ...(s.evidenceBatchIds ? { evidenceBatchIds: [...s.evidenceBatchIds] } : {}),
        ...(s.evidenceBatch ? { evidenceBatch: evidencePayload(s.evidenceBatch, s.expectedPreviousBatchId ?? null) } : {}),
      })),
      p_decisions: input.decisions.map((d) => {
        const { reviewerId: _discarded, ...rest } = d;
        return json(rest);
      }),
      p_evaluation: input.evaluation ? { ...input.evaluation, findings: json(input.evaluation.findings) } : null,
    });
  }

  async setPublicationState(reportId: string, reportVersion: number, companyId: string, state: "DRAFT" | "REVIEWED" | "FINAL", reason: string): Promise<PublicationRow> {
    const r = await this.call<Record<string, unknown>>("fs_set_publication_state", { p_report_id: reportId, p_report_version: reportVersion, p_company_id: companyId, p_state: state, p_reason: reason });
    return toPublicationRow(r);
  }

  async latestReport(companyId: string, periodYear: number, provenanceOrigin: string): Promise<StoredReportRow | null> {
    const rows = await this.read("financial_statement_reports", { company_id: companyId, period_year: periodYear, provenance_origin: provenanceOrigin });
    if (rows.length === 0) return null;
    const latest = [...rows].sort((a, b) => Number(b.report_version) - Number(a.report_version))[0];
    return toReportRow(latest);
  }

  /** Every saved version of this company's report for the year, from the server's member-only listing. Never trusts a cache. */
  async listSavedVersions(companyId: string, periodYear: number): Promise<readonly SavedVersionSummary[]> {
    const rows = await this.call<readonly Record<string, unknown>[] | null>("fs_list_saved_versions", { p_company_id: companyId, p_period_year: periodYear });
    return (rows ?? []).map((r) => ({
      reportId: String(r.reportId),
      reportVersion: Number(r.reportVersion),
      createdAt: String(r.createdAt),
      creatorRole: String(r.creatorRole),
      creatorRef: String(r.creatorRef),
      contentHash: String(r.contentHash),
      evidenceBatchIds: ((r.evidenceBatchIds ?? []) as unknown[]).map(String),
      state: r.state as SavedVersionSummary["state"],
      isLatest: r.isLatest === true,
    }));
  }

  /** The server's own answer to "could this version be marked REVIEWED/FINAL?" — a preview; fs_set_publication_state re-checks it. */
  async reportReadiness(companyId: string, reportId: string, reportVersion: number): Promise<ReportReadiness> {
    const r = await this.call<{ ready?: boolean; blockers?: unknown[] } | null>("fs_report_readiness", { p_company_id: companyId, p_report_id: reportId, p_report_version: reportVersion });
    return { ready: r?.ready === true, blockers: (r?.blockers ?? []).map(String) };
  }

  /** Reads one exact immutable version. A row that does not belong to `companyId` is treated as not found, whatever the server returned. */
  async readReportVersion(companyId: string, reportId: string, reportVersion: number): Promise<StoredReportRow | null> {
    const rows = await this.read("financial_statement_reports", { report_id: reportId, report_version: reportVersion });
    const row = rows.find((r) => String(r.company_id) === companyId);
    return row ? toReportRow(row) : null;
  }

  async listReportVersions(reportId: string): Promise<readonly StoredReportRow[]> {
    const rows = await this.read("financial_statement_reports", { report_id: reportId });
    return rows.map(toReportRow).sort((a, b) => a.reportVersion - b.reportVersion);
  }

  async listEvaluations(reportId: string, reportVersion: number): Promise<readonly StoredEvaluationRow[]> {
    const rows = await this.read("financial_statement_evaluations", { report_id: reportId, report_version: reportVersion });
    return rows
      .map((r) => ({ evaluationRunId: String(r.evaluation_run_id), reportVersion: Number(r.report_version), rulePackId: String(r.rule_pack_id), rulePackVersion: String(r.rule_pack_version), engineVersion: String(r.engine_version), inputHash: String(r.input_hash), findings: reviveDocument(r.findings) as readonly RuleEvaluationRecord[], createdAt: String(r.created_at), seq: Number(r.seq) }))
      .sort((a, b) => a.seq - b.seq)
      .map(({ seq: _s, ...rest }) => rest);
  }

  async listDecisions(reportId: string): Promise<readonly StoredDecisionRow[]> {
    const rows = await this.read("financial_statement_reviewer_decisions", { report_id: reportId });
    return rows
      .map((r) => ({ decisionId: String(r.decision_id), decision: { ...(reviveDocument(r.decision) as object), reviewerId: String(r.reviewer_firm_member_id) } as ReviewerDecision, reviewerFirmMemberId: String(r.reviewer_firm_member_id), correctionGroupId: r.correction_group_id === null ? null : String(r.correction_group_id), seq: Number(r.seq) }))
      .sort((a, b) => a.seq - b.seq);
  }

  async listPublications(reportId: string): Promise<readonly PublicationRow[]> {
    const rows = await this.read("financial_statement_publications", { report_id: reportId });
    return rows.map(toPublicationRow).sort((a, b) => a.seq - b.seq);
  }
}

// ─── row mappers ───────────────────────────────────────────────────────────

/** JSONB read back from the database revives {"__bigint__": "..."} into bigint. */
export function reviveDocument(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === "__bigint__" && typeof (v as { __bigint__: unknown }).__bigint__ === "string") return BigInt((v as { __bigint__: string }).__bigint__);
    }
    return v;
  });
}

function contentHashOfDocument(report: CanonicalFinancialStatementReport): string {
  return sha256Hex(canonicalStringify(report));
}

function toReportRow(r: Record<string, unknown>): StoredReportRow {
  return {
    report: deserializeReport(JSON.stringify(r.report_document)),
    reportVersion: Number(r.report_version),
    contentHash: String(r.content_hash),
    createdAt: String(r.created_at),
    companyId: String(r.company_id),
    evidenceBatchIds: ((r.evidence_batch_ids ?? []) as unknown[]).map(String),
  };
}

function toEvidenceRow(r: Record<string, unknown>): StoredEvidenceRow {
  return {
    evidenceBatchId: String(r.evidence_batch_id),
    evidenceType: String(r.evidence_type),
    periodRole: String(r.period_role),
    reportingPeriodId: String(r.reporting_period_id),
    seriesKey: String(r.series_key),
    schemaVersion: String(r.schema_version ?? "1"),
    version: Number(r.version),
    validationStatus: String(r.validation_status),
    contentHash: String(r.content_hash),
    replayIdentity: String(r.replay_identity),
    supersedesBatchId: r.supersedes_batch_id === null || r.supersedes_batch_id === undefined ? null : String(r.supersedes_batch_id),
    diagnostics: (r.diagnostics ?? []) as readonly EvidenceDiagnostic[],
    document: r.batch_document,
    sourceFileName: r.source_file_name === null || r.source_file_name === undefined ? null : String(r.source_file_name),
    currency: r.currency === null || r.currency === undefined ? null : String(r.currency),
    scale: r.scale === null || r.scale === undefined ? null : Number(r.scale),
    createdAt: String(r.created_at),
  };
}

function toPublicationRow(r: Record<string, unknown>): PublicationRow {
  return { reportVersion: Number(r.report_version), state: r.state as PublicationRow["state"], reason: String(r.reason), createdAt: String(r.created_at), seq: Number(r.seq ?? 0) };
}
