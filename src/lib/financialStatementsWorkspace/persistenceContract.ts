// financialStatementsWorkspace/persistenceContract.ts — the client side of the
// persistence contract authored in 20260917000000_financial_statement_reports.sql.
//
//  - READS go straight to the three tables through the caller's own
//    authenticated session (RLS: accepted firm members of the company only).
//  - WRITES never touch a table from the browser (no table grant or write
//    policy exists). They go through one Edge Function,
//    `financial-statement-workspace`, which must call the three SECURITY DEFINER
//    RPCs with the caller's own JWT (never a service-role key: under it
//    auth.uid() is NULL and every RPC refuses). Each RPC derives the acting
//    firm_members.id itself from auth.uid() and re-checks company membership.
//    The client therefore NEVER sends an actor id: the request types below
//    contain none, and toAppendDecisionRequest strips any reviewerId (the RPC
//    discards it too).
//  - Money is serialized with canonicalStringify (bigint minor units as
//    {"__bigint__": "..."}), never as a JSON number.
//
// Until FINANCIAL_STATEMENT_PERSISTENCE_ENABLED is true every write throws
// PersistenceUnavailableError before any network call is made.

import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import type { CanonicalFinancialStatementReport, ReviewerDecision, RuleEvaluationRecord, RulePackIdentity } from "@/lib/canonicalStatement/types";
import { FINANCIAL_STATEMENT_PERSISTENCE_ENABLED } from "./persistenceGate";
import type { EvaluationRunRecord, FinancialStatementReportRepository, StoredReportSnapshot } from "./reportRepository";

export const WORKSPACE_FUNCTION_NAME = "financial-statement-workspace";

// ─── Persistence state (what the UI must distinguish) ──────────────────────

export type PersistenceState = "UNSAVED_DRAFT" | "PERSISTED" | "UNAVAILABLE" | "STALE_VERSION" | "PERMISSION_DENIED";

export class PersistenceUnavailableError extends Error {
  constructor(message = "Saving is not available yet: the persistence layer has not been enabled for this workspace.") {
    super(message);
    this.name = "PersistenceUnavailableError";
  }
}
export class PersistencePermissionError extends Error {
  constructor(message = "You do not have permission to save statements for this company.") {
    super(message);
    this.name = "PersistencePermissionError";
  }
}
export class PersistenceStaleVersionError extends Error {
  constructor(message = "This report changed since you loaded it. Reload to see the latest version before saving.") {
    super(message);
    this.name = "PersistenceStaleVersionError";
  }
}

/** Maps any error from the persistence path to the state the UI shows. Unknown failures are UNAVAILABLE, never PERSISTED. */
export function classifyPersistenceError(err: unknown): PersistenceState {
  if (err instanceof PersistencePermissionError) return "PERMISSION_DENIED";
  if (err instanceof PersistenceStaleVersionError) return "STALE_VERSION";
  if (err instanceof PersistenceUnavailableError) return "UNAVAILABLE";
  const e = err as { code?: string; message?: string } | null;
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  if (/42501|FORBIDDEN|not an accepted member|permission denied/i.test(text)) return "PERMISSION_DENIED";
  if (/STALE_REPORT_VERSION|stale/i.test(text)) return "STALE_VERSION";
  return "UNAVAILABLE";
}

export function initialPersistenceState(): PersistenceState {
  return FINANCIAL_STATEMENT_PERSISTENCE_ENABLED ? "UNSAVED_DRAFT" : "UNAVAILABLE";
}

// ─── Serialization (decimal-safe) ──────────────────────────────────────────

function reviveBigInt(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === "__bigint__" && typeof (value as { __bigint__: unknown }).__bigint__ === "string") {
      return BigInt((value as { __bigint__: string }).__bigint__);
    }
  }
  return value;
}

export function serializeDocument(value: unknown): string {
  return canonicalStringify(value);
}

export function parseDocument(json: string): unknown {
  return JSON.parse(json, reviveBigInt);
}

/** Parses and re-validates a stored report: a stored document is never trusted just because it came from our own table. */
export function deserializeReport(json: string): CanonicalFinancialStatementReport {
  return validateCanonicalReport(parseDocument(json));
}

export function contentHashOf(report: CanonicalFinancialStatementReport): string {
  return sha256Hex(canonicalStringify(report));
}

// ─── Write requests (no actor id anywhere) ─────────────────────────────────

export type WriteRequest =
  | { readonly action: "save_report"; readonly reportId: string; readonly reportVersion: number; readonly companyId: string; readonly periodYear: number; readonly provenanceOrigin: string; readonly reportDocument: string; readonly contentHash: string }
  | { readonly action: "save_evaluation"; readonly evaluationRunId: string; readonly reportId: string; readonly reportVersion: number; readonly companyId: string; readonly rulePackId: string; readonly rulePackVersion: string; readonly engineVersion: string; readonly inputHash: string; readonly findings: string }
  | { readonly action: "append_decision"; readonly decisionId: string; readonly reportId: string; readonly companyId: string; readonly decision: string };

export function toSaveReportRequest(snapshot: StoredReportSnapshot): WriteRequest {
  const r = snapshot.report;
  return { action: "save_report", reportId: r.reportIdentity.reportId, reportVersion: r.reportIdentity.reportVersion, companyId: r.reportIdentity.companyId, periodYear: r.period.periodYear, provenanceOrigin: r.provenanceOrigin, reportDocument: serializeDocument(r), contentHash: contentHashOf(r) };
}

export function toSaveEvaluationRequest(run: EvaluationRunRecord, companyId: string): WriteRequest {
  return { action: "save_evaluation", evaluationRunId: run.evaluationRunId, reportId: run.reportId, reportVersion: run.reportVersion, companyId, rulePackId: run.rulePack.rulePackId, rulePackVersion: run.rulePack.rulePackVersion, engineVersion: run.engineVersion, inputHash: run.inputHash, findings: serializeDocument(run.findings) };
}

export function toAppendDecisionRequest(reportId: string, companyId: string, decision: ReviewerDecision): WriteRequest {
  // The server sets reviewerId from the authenticated firm member; whatever the client held is discarded.
  const { reviewerId: _discarded, ...withoutActor } = decision;
  return { action: "append_decision", decisionId: decision.decisionId, reportId, companyId, decision: serializeDocument(withoutActor) };
}

// ─── Transport + remote repository ─────────────────────────────────────────

export interface PersistenceTransport {
  /** Read rows from one of the three tables via the caller's own RLS-scoped session. */
  select(table: "financial_statement_reports" | "financial_statement_evaluations" | "financial_statement_reviewer_decisions", filters: Readonly<Record<string, string | number>>): Promise<readonly Record<string, unknown>[]>;
  /** Invoke the write Edge Function. Rejects with the function's error payload. */
  invoke(request: WriteRequest): Promise<void>;
}

export class RemoteFinancialStatementReportRepository implements FinancialStatementReportRepository {
  constructor(private readonly transport: PersistenceTransport, private readonly enabled: boolean = FINANCIAL_STATEMENT_PERSISTENCE_ENABLED) {}

  private assertEnabled(): void {
    if (!this.enabled) throw new PersistenceUnavailableError();
  }

  private async write(request: WriteRequest): Promise<void> {
    this.assertEnabled();
    try {
      await this.transport.invoke(request);
    } catch (err) {
      const state = classifyPersistenceError(err);
      if (state === "PERMISSION_DENIED") throw new PersistencePermissionError();
      if (state === "STALE_VERSION") throw new PersistenceStaleVersionError();
      throw err instanceof PersistenceUnavailableError ? err : new PersistenceUnavailableError(err instanceof Error ? err.message : "The save could not be completed.");
    }
  }

  private async decisionsFor(reportId: string): Promise<StoredReportSnapshot["decisions"]> {
    const rows = await this.transport.select("financial_statement_reviewer_decisions", { report_id: reportId });
    return rows.map((r) => parseDocument(JSON.stringify(r.decision)) as ReviewerDecision & { reviewerId: string }).map((d, i) => ({ ...d, reviewerId: String(rows[i].reviewer_firm_member_id ?? "") })) as StoredReportSnapshot["decisions"];
  }

  async getLatestByCompanyPeriod(companyId: string, periodYear: number, provenanceOrigin: CanonicalFinancialStatementReport["provenanceOrigin"]): Promise<StoredReportSnapshot | null> {
    const rows = await this.transport.select("financial_statement_reports", { company_id: companyId, period_year: periodYear, provenance_origin: provenanceOrigin });
    if (rows.length === 0) return null;
    const latest = [...rows].sort((a, b) => Number(b.report_version) - Number(a.report_version))[0];
    const report = deserializeReport(JSON.stringify(latest.report_document));
    return { report, decisions: await this.decisionsFor(report.reportIdentity.reportId) };
  }

  async getByReportId(reportId: string): Promise<StoredReportSnapshot | null> {
    const rows = await this.transport.select("financial_statement_reports", { report_id: reportId });
    if (rows.length === 0) return null;
    const latest = [...rows].sort((a, b) => Number(b.report_version) - Number(a.report_version))[0];
    return { report: deserializeReport(JSON.stringify(latest.report_document)), decisions: await this.decisionsFor(reportId) };
  }

  async saveReport(snapshot: StoredReportSnapshot): Promise<void> {
    this.assertEnabled();
    // The write RPC enforces exact latest+1. A correction that re-derives dependent totals spans
    // several reportVersions in ONE snapshot; sending only the last would be rejected as stale, and
    // silently dropping the intermediate versions would corrupt the audit trail. Refuse explicitly.
    const stored = await this.getByReportId(snapshot.report.reportIdentity.reportId);
    const expected = (stored?.report.reportIdentity.reportVersion ?? 0) + 1;
    const actual = snapshot.report.reportIdentity.reportVersion;
    if (actual > expected) {
      throw new PersistenceUnavailableError("This correction spans several report versions, and saving a multi-version correction chain is not supported yet. Nothing was saved.");
    }
    await this.write(toSaveReportRequest(snapshot));
  }

  async getEvaluationRun(reportId: string, reportVersion: number, rulePack: RulePackIdentity): Promise<EvaluationRunRecord | null> {
    const rows = await this.transport.select("financial_statement_evaluations", { report_id: reportId, report_version: reportVersion, rule_pack_id: rulePack.rulePackId, rule_pack_version: rulePack.rulePackVersion });
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      evaluationRunId: String(r.evaluation_run_id),
      reportId,
      reportVersion,
      inputHash: String(r.input_hash),
      rulePack,
      engineVersion: String(r.engine_version),
      findings: parseDocument(JSON.stringify(r.findings)) as readonly RuleEvaluationRecord[],
      createdAt: String(r.created_at),
    };
  }

  async saveEvaluationRun(run: EvaluationRunRecord): Promise<void> {
    const snapshot = await this.getByReportId(run.reportId);
    if (!snapshot) throw new PersistenceStaleVersionError("The report for this evaluation is not saved yet.");
    await this.write(toSaveEvaluationRequest(run, snapshot.report.reportIdentity.companyId));
  }

  async appendDecision(reportId: string, decision: ReviewerDecision): Promise<void> {
    const snapshot = await this.getByReportId(reportId);
    if (!snapshot) throw new PersistenceStaleVersionError("The report for this decision is not saved yet.");
    await this.write(toAppendDecisionRequest(reportId, snapshot.report.reportIdentity.companyId, decision));
  }
}
