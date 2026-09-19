// financialStatementsWorkspace/exports.ts — deterministic export builders.
//
// Pure: no clock, no network, no DOM. The caller supplies `exportedAt` where a
// timestamp is wanted, so identical inputs give byte-identical files. Money is
// exported as exact decimal strings plus the raw minor units as a string — never as a
// JSON number. Anything a spreadsheet could evaluate is neutralised by csvCell().
//
// Scope, stated plainly: web view, print/PDF (browser), canonical JSON, evidence JSON,
// findings CSV, budget CSV and an audit bundle. There is NO DOCX generator and NO
// XBRL/iXBRL producer; XBRL is represented only by the adapter contract below, which
// nothing implements, and no export claims filing readiness.

import { formatMoney } from "@/lib/canonicalStatement/money";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import type { CanonicalFinancialStatementReport, ReviewerDecision, RuleEvaluationRecord } from "@/lib/canonicalStatement/types";
import { toCsv } from "@/lib/financialEvidence/csv";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import type { BudgetActualComparison } from "@/lib/financialGeneration/budgetActual";
import type { ChecklistItem } from "@/lib/financialGeneration/notesAndSchedules";

export interface ExportFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly content: string;
}

export type OutputStatus = "DRAFT" | "REVIEWED" | "FINAL";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "report";
const base = (r: CanonicalFinancialStatementReport, version: number | null) => `${slugify(r.entity.legalName)}-${r.period.periodYear}-v${version ?? r.reportIdentity.reportVersion}`;
const pretty = (value: unknown) => JSON.stringify(JSON.parse(canonicalStringify(value)), null, 2) + "\n";

/** The state an output may be stamped with: only a server-recorded state counts, and blockers always force DRAFT. */
export function outputStatus(publication: OutputStatus | null, blockerCount: number): OutputStatus {
  if (blockerCount > 0 || publication === null) return "DRAFT";
  return publication;
}

export function canonicalJsonExport(report: CanonicalFinancialStatementReport, storedVersion: number | null): ExportFile {
  return { fileName: `${base(report, storedVersion)}.canonical.json`, mimeType: "application/json", content: pretty(report) };
}

export function evidenceExport(report: CanonicalFinancialStatementReport, evidence: readonly { readonly batch: EvidenceBatch; readonly version: number }[]): ExportFile {
  const rows = evidence.map(({ batch, version }) => ({
    evidenceBatchId: batch.evidenceBatchId,
    evidenceType: batch.evidenceType,
    periodRole: batch.periodRole,
    reportingPeriodId: batch.reportingPeriodId,
    seriesKey: batch.seriesKey,
    version,
    sourceFileName: batch.sourceFileName,
    contentHash: batch.contentHash,
    replayIdentity: batch.replayIdentity,
    validationStatus: batch.validationStatus,
    currency: batch.currency,
    scale: batch.scale === null ? null : String(batch.scale),
    diagnostics: batch.diagnostics,
    document: batch.document,
  }));
  return { fileName: `${base(report, null)}.evidence.json`, mimeType: "application/json", content: pretty({ schema: "cfoclose.evidence-export.v1", batches: rows }) };
}

export interface AuditInput {
  readonly report: CanonicalFinancialStatementReport;
  readonly storedVersion: number | null;
  readonly evaluation: { readonly rulePack: { readonly rulePackId: string; readonly rulePackVersion: string }; readonly engineVersion: string; readonly inputHash: string; readonly findings: readonly RuleEvaluationRecord[] } | null;
  readonly decisions: readonly ReviewerDecision[];
  readonly evidence: readonly { readonly batch: EvidenceBatch; readonly version: number }[];
  readonly publication: { readonly state: OutputStatus; readonly reason: string } | null;
  /** Supplied by the caller; omitted from the file when null so the export stays reproducible. */
  readonly exportedAt: string | null;
}

/** Audit bundle: what was produced, from which evidence, checked by which rules, decided by whom (as recorded), with hashes. */
export function auditExport(input: AuditInput): ExportFile {
  const { report } = input;
  const open = input.evaluation?.findings.filter((f) => f.actionable) ?? [];
  const bundle = {
    schema: "cfoclose.audit-export.v1",
    ...(input.exportedAt ? { exportedAt: input.exportedAt } : {}),
    report: { reportId: report.reportIdentity.reportId, companyId: report.reportIdentity.companyId, periodYear: report.period.periodYear, framework: report.framework.kind, provenanceOrigin: report.provenanceOrigin, sessionReportVersion: report.reportIdentity.reportVersion, storedVersion: input.storedVersion, contentHash: sha256Hex(canonicalStringify(report)) },
    publication: input.publication,
    evaluation: input.evaluation ? { rulePack: input.evaluation.rulePack, engineVersion: input.evaluation.engineVersion, inputHash: input.evaluation.inputHash, findingCount: input.evaluation.findings.length, actionableCount: open.length } : null,
    evidence: input.evidence.map(({ batch, version }) => ({ evidenceBatchId: batch.evidenceBatchId, evidenceType: batch.evidenceType, periodRole: batch.periodRole, version, contentHash: batch.contentHash, validationStatus: batch.validationStatus })),
    decisions: input.decisions.map((d) => ({ decisionId: d.decisionId, decisionType: d.decisionType, reviewerId: d.reviewerId, decidedAt: d.decidedAt, rationale: d.rationale ?? null })),
    facts: { total: report.facts.length, corrected: report.facts.filter((f) => f.supersedesVersion !== null).length },
  };
  return { fileName: `${base(report, input.storedVersion)}.audit.json`, mimeType: "application/json", content: pretty(bundle) };
}

export function findingsCsv(report: CanonicalFinancialStatementReport, findings: readonly RuleEvaluationRecord[]): ExportFile {
  const header = ["rule_id", "outcome", "severity", "actionable", "affected", "calculation", "guidance", "finding_key"];
  const rows = findings.map((f) => [f.ruleId, f.outcome, f.failureSeverity, f.actionable ? "Y" : "N", f.affected.lineId ?? f.affected.noteId ?? f.affected.statementId ?? "", f.deterministicCalculation, f.remediationGuidance, f.findingKey]);
  return { fileName: `${base(report, null)}.findings.csv`, mimeType: "text/csv", content: toCsv([header, ...rows]) };
}

export function budgetCsv(report: CanonicalFinancialStatementReport, comparison: BudgetActualComparison): ExportFile {
  const header = ["line_key", "label", "nature", "basis", "budget", "actual", "variance", "variance_percent", "direction", "preparer_explanation", "notes"];
  const money = (m: { currency: string; scale: number; minorUnits: bigint } | null) => (m ? formatMoney(m) : "");
  const rows = comparison.lines.map((l) => [l.lineKey, l.label, l.nature, l.comparisonBasis, money(l.budget), money(l.actual), money(l.variance), l.variancePercent ?? "", l.direction, l.preparerExplanation ?? "", l.notes.join(" ")]);
  return { fileName: `${base(report, null)}.budget-vs-actual.csv`, mimeType: "text/csv", content: toCsv([header, ...rows]) };
}

export function checklistCsv(report: CanonicalFinancialStatementReport, checklist: readonly ChecklistItem[]): ExportFile {
  return { fileName: `${base(report, null)}.disclosure-checklist.csv`, mimeType: "text/csv", content: toCsv([["area", "reference", "state", "satisfied_by", "rationale"], ...checklist.map((c) => [c.label, c.reference, c.state, c.satisfiedBy ?? "", c.rationale ?? ""])]) };
}

// ─── XBRL boundary (contract only) ─────────────────────────────────────────

/** What a future, separately-certified XBRL/iXBRL producer would have to implement. Nothing in this repository does. */
export interface XbrlExportAdapter {
  readonly taxonomy: string;
  readonly adapterVersion: string;
  produce(report: CanonicalFinancialStatementReport): { readonly package: Uint8Array; readonly validationReport: string };
}

export const XBRL_EXPORT = { available: false as const, reason: "No XBRL/iXBRL producer or taxonomy conformance validation exists in this product. Facts keep provenance so a certified adapter can be added; no filing readiness is claimed." };
export const DOCX_EXPORT = { available: false as const, reason: "No DOCX generator exists that preserves statement layout faithfully; a low-fidelity file would misrepresent the statements." };
