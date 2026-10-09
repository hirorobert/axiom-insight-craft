// financialGeneration/composedReport.ts — the one report document the reporting workbench saves for an IFRS for SMEs
// trial-balance report: the statements the DATABASE composed (fs_statement_composition, via composedStatements), the
// statements the EXISTING evidence generators build (cash flows and changes in equity, applyEvidence), the notes the
// database holds (fs_notes_status and the recorded wording), and the reporting-dependencies identity the sign-off binds.
//
// Pure and deterministic: the same inputs always give the same bytes. It adds nothing up — composed figures are server
// figures, evidence statements are the generators' — and it supplies nothing the inputs do not hold: a checklist area whose
// server requirement is not satisfied is recorded as MISSING (the server then refuses sign-off by name), never as provided.

import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport, type RuleEvaluationRecord, type TextualDisclosure } from "@/lib/canonicalStatement/types";
import { buildRuleContext } from "@/lib/canonicalStatement/rules/ruleEngine";
import { runCanonicalRulePackV2, CANONICAL_RULE_PACK_V2, ENGINE_VERSION_V2 } from "@/lib/canonicalStatement/rules/rulePack";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { FRAMEWORK_PROFILES } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { deserializeReport } from "@/lib/financialStatementsWorkspace/persistenceContract";
import { composedStatements, type ReportingDependenciesRef } from "@/lib/statements/canonicalDocument";
import type { Composition } from "@/lib/statements/composition";
import type { NotesStatus } from "@/lib/notes/notesStatus";
import { applyEvidence, type EvidenceUse } from "./applyEvidence";
import type { PeriodCashScope } from "./cashPerimeter";
import type { CashScopeInput } from "@/lib/reporting/cashScope";
import type { GenerationDiagnostic } from "./common";
import type { MappingCoverage } from "./persistedAuthority";

/** The server's notes requirement that satisfies each framework-profile disclosure area (frameworkProfiles.ts). */
export const CHECKLIST_AREA_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "basis-of-preparation": ["smes.note.compliance"],
  "accounting-policies": ["smes.note.policies"],
  // Notes supporting the line items: every blocking disclosure and schedule requirement of the pack.
  "supporting-notes": [],
});

export interface RecordedDisclosure {
  readonly requirementId: string;
  /** fs_disclosure_texts.id — the server's notes status names the text in force by this id. */
  readonly textId: string;
  readonly body: string;
  readonly sourceRef: string | null;
}

export interface ComposedReportInput {
  readonly reportId: string;
  readonly reportVersion: number;
  readonly companyId: string;
  readonly legalName: string;
  readonly composition: Composition;
  /** fs_reporting_input period dates (never assumed). */
  readonly currentDates: { readonly start: string; readonly end: string };
  readonly comparativeDates: { readonly start: string; readonly end: string } | null;
  readonly dependencies: ReportingDependenciesRef;
  readonly notes: NotesStatus;
  /** The recorded wording; only the texts the notes status names as in force are used. */
  readonly disclosures: readonly RecordedDisclosure[];
  /** Latest version of each evidence series for the period. */
  readonly evidence: readonly EvidenceBatch[];
  /** Each period's accounts from its authoritative reporting input (cashScopeFromReportingInput); never company-wide. */
  readonly cashScope: CashScopeInput;
}

export interface ComposedReportResult {
  readonly report: CanonicalFinancialStatementReport | null;
  readonly diagnostics: readonly GenerationDiagnostic[];
  readonly use: readonly EvidenceUse[];
  readonly mappingCoverage: MappingCoverage;
}

/** Mapping coverage as the composition states it: every current-period account is presented, unassigned or incompatible. */
export function compositionCoverage(c: Composition): MappingCoverage {
  const presented = new Set(c.lines.flatMap((l) => l.lineage.filter((x) => x.period === "current" && x.kind === "account").map((x) => x.accountKey)));
  const notPresented = c.accountsNotPresented.filter((a) => a.period === "current");
  return {
    total: presented.size + notPresented.length,
    unmapped: notPresented.filter((a) => a.status !== "incompatible").length,
    ambiguous: notPresented.filter((a) => a.status === "incompatible").length,
  };
}

const SATISFIED = new Set(["provided", "not_applicable", "satisfied", "composed", "evidence_present", "derived", "reconciled", "reconciled_opening_unverified"]);

function checklistFromNotes(notes: NotesStatus, sourceHash: string): TextualDisclosure[] {
  const profile = FRAMEWORK_PROFILES.IFRS_FOR_SMES;
  return [...profile.disclosureAreas]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((area) => {
      const named = CHECKLIST_AREA_REQUIREMENTS[area.id] ?? [];
      const reqs = named.length > 0 ? notes.requirements.filter((r) => named.includes(r.requirementId))
        : notes.requirements.filter((r) => r.blocking && (r.kind === "DISCLOSURE" || r.kind === "SCHEDULE"));
      const ok = reqs.length > 0 && reqs.every((r) => SATISFIED.has(r.status));
      const text = `${ok ? "PROVIDED" : "MISSING"}: ${area.label} (${area.reference}) — notes status ${notes.statusSha256.slice(0, 12)}: ${reqs.map((r) => `${r.requirementId}=${r.status}`).join(", ") || "no requirement"}`;
      return {
        disclosureId: `checklist:${area.id}`, text,
        provenance: { source: { sourceDocumentId: `fs-notes-status:${notes.statusSha256}`, sourceHash, artifactKind: "TRIAL_BALANCE" },
          locator: { kind: "MANUAL", note: `server notes status for ${named.join(", ") || "every blocking disclosure and schedule"}` },
          extractionMethod: "TRIAL_BALANCE_DERIVED", extractionConfidence: { kind: "CERTAIN" }, originalText: text },
      } as TextualDisclosure;
    });
}

function recordedNotes(notes: NotesStatus, disclosures: readonly RecordedDisclosure[], sourceHash: string): TextualDisclosure[] {
  const inForce = new Map(notes.requirements.filter((r) => r.textId).map((r) => [r.textId!, r.requirementId] as const));
  return disclosures
    .filter((d) => inForce.get(d.textId) === d.requirementId)
    .sort((a, b) => (a.requirementId < b.requirementId ? -1 : 1))
    .map((d) => ({
      disclosureId: d.requirementId, text: d.body,
      provenance: { source: { sourceDocumentId: `fs-disclosure-text:${d.textId}`, sourceHash, artifactKind: "TRIAL_BALANCE" },
        locator: { kind: "MANUAL", note: d.sourceRef ? `recorded wording; source ${d.sourceRef}` : "recorded wording" },
        extractionMethod: "TRIAL_BALANCE_DERIVED", extractionConfidence: { kind: "CERTAIN" }, originalText: d.body },
    }) as TextualDisclosure);
}

export function assembleComposedReport(input: ComposedReportInput): ComposedReportResult {
  const c = input.composition;
  const tci = input.notes.requirements.find((r) => r.requirementId === "smes.sci.5_5_i" && r.status === "composed")?.totalsMinor ?? null;
  const built = composedStatements(c, input.comparativeDates, tci);
  const base: CanonicalFinancialStatementReport = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: input.reportId, companyId: input.companyId, reportVersion: input.reportVersion },
    entity: { legalName: input.legalName },
    period: { periodId: "CURRENT", startDate: input.currentDates.start, endDate: input.currentDates.end, periodYear: c.current.periodYear },
    comparativePeriods: built.comparativePeriods,
    framework: { kind: "IFRS_FOR_SMES" },
    presentationCurrency: { currency: c.current.currency, scale: c.current.exponent, roundingPolicy: { mode: "HALF_UP", scale: c.current.exponent }, presentationMultiplier: 1n },
    statements: [...built.statements],
    notes: [], noteReferences: [], accountingPolicies: [], textualDisclosures: [],
    facts: [...built.facts],
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  } as CanonicalFinancialStatementReport;
  const mappingCoverage = compositionCoverage(c);
  const cmpId = built.comparativePeriods[0]?.periodId ?? null;
  const cashScope: PeriodCashScope[] = [{ periodId: "CURRENT", accounts: input.cashScope.current },
    ...(cmpId && input.cashScope.comparative ? [{ periodId: cmpId, accounts: input.cashScope.comparative }] : [])];
  const applied = applyEvidence({ report: base, profile: FRAMEWORK_PROFILES.IFRS_FOR_SMES, evidence: input.evidence, cashScope, mappingCoverage });
  if (!applied.report) return { report: null, diagnostics: applied.diagnostics, use: applied.use, mappingCoverage };
  // The checklist is the server's notes status, not an evidence batch: replace the generator's (evidence-based) records.
  const kept = applied.report.textualDisclosures.filter((d) => !d.disclosureId.startsWith("checklist:"));
  const report = {
    ...applied.report,
    textualDisclosures: [...kept, ...recordedNotes(input.notes, input.disclosures, c.inputSha256), ...checklistFromNotes(input.notes, c.inputSha256)],
    reportingDependencies: { ...input.dependencies },
  } as CanonicalFinancialStatementReport;
  return { report, diagnostics: applied.diagnostics, use: applied.use, mappingCoverage };
}

/** sha256 of the canonical serialisation — the content hash the save path declares (the server computes its own). */
export const reportContentHash = (report: CanonicalFinancialStatementReport): string => sha256Hex(canonicalStringify(report));

/** The canonical rule pack's evaluation of the report, with the same deterministic identity the existing save path uses. */
export function evaluateComposedReport(report: CanonicalFinancialStatementReport, clock: () => string = () => new Date().toISOString()) {
  const inputHash = reportContentHash(report);
  const findings: readonly RuleEvaluationRecord[] = runCanonicalRulePackV2(buildRuleContext(report, ZERO_TOLERANCE), clock);
  return {
    evaluationRunId: sha256Hex(canonicalStringify({ reportId: report.reportIdentity.reportId, reportVersion: report.reportIdentity.reportVersion, rulePack: CANONICAL_RULE_PACK_V2, engineVersion: ENGINE_VERSION_V2, inputHash })),
    rulePackId: CANONICAL_RULE_PACK_V2.rulePackId, rulePackVersion: CANONICAL_RULE_PACK_V2.rulePackVersion, engineVersion: ENGINE_VERSION_V2,
    inputHash, findings,
  };
}

/**
 * A stored version's document, re-validated (a stored document is never trusted because it came from our own table), with
 * the reporting-dependencies identity it was bound to kept beside it.
 */
export function readStoredReport(document: unknown): CanonicalFinancialStatementReport & { readonly reportingDependencies?: ReportingDependenciesRef } {
  const report = deserializeReport(JSON.stringify(document));
  const deps = (document as { reportingDependencies?: ReportingDependenciesRef } | null)?.reportingDependencies;
  return deps ? { ...report, reportingDependencies: deps } as CanonicalFinancialStatementReport & { reportingDependencies: ReportingDependenciesRef } : report;
}
