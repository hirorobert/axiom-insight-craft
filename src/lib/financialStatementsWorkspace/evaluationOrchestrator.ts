// financialStatementsWorkspace/evaluationOrchestrator.ts — Phase 3: the one
// application service that turns a reviewed trial balance into a validated,
// deterministically-evaluated canonical report, and exposes the only
// sanctioned way to record a reviewer decision against it.
//
// This module performs NO Supabase I/O of its own — it depends only on
// FinancialStatementReportRepository (reportRepository.ts). A real
// Supabase-backed repository belongs behind an Edge Function (Iron Dome
// 4.2: financial writes are Edge-Function-only; React components/hooks
// stay read-only), calling this same orchestrator so the identical
// idempotency/versioning logic runs in both a test and production —
// nothing here special-cases "test mode."

import { sha256Hex, canonicalStringify } from "@/lib/canonicalStatement/serialization";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { buildRuleContext, type Clock, systemClock } from "@/lib/canonicalStatement/rules/ruleEngine";
import { runCanonicalRulePackV1, CANONICAL_RULE_PACK_V1, ENGINE_VERSION } from "@/lib/canonicalStatement/rules/rulePack";
import { recordFactCorrection, type CanonicalReviewState } from "@/lib/canonicalStatement/reviewState";
import { appendDecision as appendStandaloneDecision, type StandaloneReviewerDecision } from "@/lib/canonicalStatement/reviewerDecisions";
import { ZERO_TOLERANCE, formatMoney, isValidCurrencyCode, type Tolerance } from "@/lib/canonicalStatement/money";
import { indexLatestFacts } from "@/lib/canonicalStatement/provenance";
import type {
  CanonicalFinancialStatementReport,
  ComparativePeriod,
  CorrectFactDecision,
  ProvenanceRecord,
  ReportingPeriod,
} from "@/lib/canonicalStatement/types";
import { CANONICAL_SCHEMA_VERSION } from "@/lib/canonicalStatement/types";
import { createTrialBalanceAdapter, type ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";
import { resolveCanonicalFramework, UnresolvedCurrencyError } from "./adapterContract";
import type { EvaluationRunRecord, FinancialStatementReportRepository, StoredReportSnapshot } from "./reportRepository";

export interface PrepareTrialBalanceReportParams {
  readonly companyId: string;
  readonly periodYear: number;
  readonly entityLegalName: string;
  readonly taxIdentificationNumber?: string;
  /** Raw companies.reporting_framework DB value — resolved with no silent default. */
  readonly framework: string | null | undefined;
  /** Raw companies.currency DB value — resolved with no silent default. */
  readonly currency: string | null | undefined;
  readonly currentPeriod: Pick<ReportingPeriod, "startDate" | "endDate">;
  readonly comparativePeriods?: readonly ComparativePeriod[];
  readonly reviewedAccountLines: readonly unknown[];
}

export class UnsupportedFrameworkForTrialBalanceAdapterError extends Error {
  constructor(readonly framework: string) {
    super(`The trial-balance adapter builds a Statement of Financial Position + Statement of Profit or Loss and cannot honestly serve framework "${framework}" (its primary statement is a Statement of Cash Receipts and Payments)`);
    this.name = "UnsupportedFrameworkForTrialBalanceAdapterError";
  }
}

export class StaleTrialBalanceInputError extends Error {
  constructor(readonly reportId: string, readonly existingReportVersion: number) {
    super(
      `A report already exists for this company/period (reportId="${reportId}", latest reportVersion=${existingReportVersion}) and the freshly-supplied reviewed trial balance produces different content. ` +
        `Re-preparation from scratch is refused to avoid silently invalidating a lineage a reviewer may have already made decisions against — correct individual facts via recordReviewerDecision's CORRECT_FACT path instead.`,
    );
    this.name = "StaleTrialBalanceInputError";
  }
}

/** sha256 over the content that defines "the same report" — everything except reportVersion, whose own drift this hash is used to detect. */
function contentHash(report: CanonicalFinancialStatementReport): string {
  return sha256Hex(canonicalStringify({ ...report, reportIdentity: { ...report.reportIdentity, reportVersion: 0 } }));
}

function deterministicReportId(companyId: string, periodYear: number, provenanceOrigin: CanonicalFinancialStatementReport["provenanceOrigin"]): string {
  return sha256Hex(canonicalStringify({ companyId, periodYear, provenanceOrigin, kind: "financial-statement-report-id" }));
}

export type PrepareResult = { readonly status: "PREPARED" | "UNCHANGED"; readonly snapshot: StoredReportSnapshot };

/**
 * Builds (or idempotently re-fetches) a `TRIAL_BALANCE_DERIVED` canonical
 * report for a company/period from its already-reviewed trial balance. Never
 * writes to any workspace table itself — the caller (an Edge Function) owns
 * translating `repo.saveReport` into a real persisted write, scoped to the
 * caller's own authenticated company membership (Iron Dome 4.3).
 */
export async function prepareTrialBalanceReport(params: PrepareTrialBalanceReportParams, repo: FinancialStatementReportRepository): Promise<PrepareResult> {
  const framework = resolveCanonicalFramework(params.framework);
  if (framework === "IPSAS_CASH") {
    throw new UnsupportedFrameworkForTrialBalanceAdapterError(framework);
  }
  if (!params.currency || !isValidCurrencyCode(params.currency)) {
    throw new UnresolvedCurrencyError(params.currency);
  }

  const adapter = createTrialBalanceAdapter();
  const extraction = await adapter.normalize({ companyId: params.companyId, periodYear: params.periodYear, reviewedAccountLines: params.reviewedAccountLines });

  const currencyScale = extraction.facts[0]?.value?.scale ?? 2;
  const reportId = deterministicReportId(params.companyId, params.periodYear, "TRIAL_BALANCE_DERIVED");

  const freshReport = validateCanonicalReport({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId, companyId: params.companyId, reportVersion: 1 },
    entity: { legalName: params.entityLegalName, taxIdentificationNumber: params.taxIdentificationNumber },
    period: { periodId: "CURRENT", periodYear: params.periodYear, startDate: params.currentPeriod.startDate, endDate: params.currentPeriod.endDate },
    comparativePeriods: params.comparativePeriods ?? [],
    framework: { kind: framework },
    presentationCurrency: { currency: params.currency, scale: currencyScale, roundingPolicy: { mode: "HALF_UP", scale: currencyScale }, presentationMultiplier: 1n },
    statements: extraction.statements,
    notes: extraction.notes,
    noteReferences: [],
    accountingPolicies: extraction.accountingPolicies,
    textualDisclosures: extraction.textualDisclosures,
    facts: extraction.facts,
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  } satisfies CanonicalFinancialStatementReport);

  const existing = await repo.getLatestByCompanyPeriod(params.companyId, params.periodYear, "TRIAL_BALANCE_DERIVED");
  if (!existing) {
    const snapshot: StoredReportSnapshot = { report: freshReport, decisions: [] };
    await repo.saveReport(snapshot);
    return { status: "PREPARED", snapshot };
  }

  if (contentHash(existing.report) === contentHash(freshReport)) {
    return { status: "UNCHANGED", snapshot: existing };
  }

  throw new StaleTrialBalanceInputError(reportId, existing.report.reportIdentity.reportVersion);
}

/**
 * Runs (or idempotently re-fetches) the canonical rule pack against a
 * prepared report. Replaying with the identical report content never
 * creates a second evaluation row — `evaluationRunId` is a deterministic
 * hash of (reportId, reportVersion, rulePack, engineVersion), and a matching
 * `inputHash` short-circuits to the cached result.
 */
export async function evaluateReport(snapshot: StoredReportSnapshot, repo: FinancialStatementReportRepository, tolerance: Tolerance = ZERO_TOLERANCE, clock: Clock = systemClock): Promise<EvaluationRunRecord> {
  const { report } = snapshot;
  const inputHash = sha256Hex(canonicalStringify(report));
  const evaluationRunId = sha256Hex(
    canonicalStringify({
      reportId: report.reportIdentity.reportId,
      reportVersion: report.reportIdentity.reportVersion,
      rulePack: CANONICAL_RULE_PACK_V1,
      engineVersion: ENGINE_VERSION,
    }),
  );

  const existing = await repo.getEvaluationRun(report.reportIdentity.reportId, report.reportIdentity.reportVersion, CANONICAL_RULE_PACK_V1);
  if (existing && existing.inputHash === inputHash) {
    return existing;
  }

  const ctx = buildRuleContext(report, tolerance);
  const findings = runCanonicalRulePackV1(ctx, clock);
  const run: EvaluationRunRecord = {
    evaluationRunId,
    reportId: report.reportIdentity.reportId,
    reportVersion: report.reportIdentity.reportVersion,
    inputHash,
    rulePack: CANONICAL_RULE_PACK_V1,
    engineVersion: ENGINE_VERSION,
    findings,
    createdAt: clock(),
  };
  await repo.saveEvaluationRun(run);
  return run;
}

/**
 * Applies a fact correction atomically (via reviewState.ts's
 * recordFactCorrection — the only public way to do this) and persists the
 * resulting new report version. `decision.reviewerId` must be a
 * `firm_members.id` — Iron Dome 4.3 — never `auth.users.id`; enforcing that,
 * and that the reviewer actually holds sign-off/review authority on this
 * company, is the calling Edge Function's job (validateAuth +
 * assertCompanyMembership), not this function's.
 */
export async function correctReportFact(reportId: string, decision: CorrectFactDecision, provenance: ProvenanceRecord, repo: FinancialStatementReportRepository): Promise<StoredReportSnapshot> {
  const existing = await repo.getByReportId(reportId);
  if (!existing) throw new Error(`No stored report for reportId "${reportId}"`);
  const state: CanonicalReviewState = { report: existing.report, decisions: existing.decisions };
  const next = recordFactCorrection(state, decision, provenance);
  const snapshot: StoredReportSnapshot = { report: next.report, decisions: next.decisions };
  await repo.saveReport(snapshot);
  return snapshot;
}

/** Records any reviewer decision that is not a fact correction (see reviewerDecisions.ts — CORRECT_FACT is excluded by that module's own type). */
export async function recordReviewerDecision(reportId: string, decision: StandaloneReviewerDecision, repo: FinancialStatementReportRepository): Promise<void> {
  const existing = await repo.getByReportId(reportId);
  if (!existing) throw new Error(`No stored report for reportId "${reportId}"`);
  appendStandaloneDecision(existing.decisions, decision); // validates append-only invariant; repo.appendDecision performs the actual persisted append
  await repo.appendDecision(reportId, decision);
}

/**
 * Corrects a source figure AND re-derives every dependent subtotal/total/net
 * result, atomically. In a TRIAL_BALANCE_DERIVED report the totals are
 * derived facts; correcting only the leaf would leave every dependent total
 * mis-cast. The dependents are recomputed by re-running the deterministic
 * trial-balance adapter on the corrected input (no arithmetic is duplicated
 * here) and each changed fact is recorded as its own canonical CORRECT_FACT
 * decision, linked to the reviewer's decision by id and rationale. The whole
 * chain is built in memory through recordFactCorrection and handed to the
 * repository in ONE saveReport call, so the in-memory state transition is
 * all-or-nothing. That is NOT a claim of durable database atomicity: the chain
 * spans several reportVersions, and a persisted repository must be able to
 * store every version (the current remote contract cannot — see
 * RemoteFinancialStatementReportRepository.saveReport).
 */
export async function correctFactAndRecast(params: {
  readonly reportId: string;
  readonly decision: CorrectFactDecision;
  readonly provenance: ProvenanceRecord;
  readonly reviewedAccountLines: readonly ReviewedTrialBalanceAccountLine[];
  readonly repo: FinancialStatementReportRepository;
}): Promise<StoredReportSnapshot> {
  const { reportId, decision, provenance, reviewedAccountLines, repo } = params;
  const existing = await repo.getByReportId(reportId);
  if (!existing) throw new Error(`No stored report for reportId "${reportId}"`);
  if (decision.correctedValue === null) throw new Error("A recast correction needs a concrete corrected amount.");

  const adapter = createTrialBalanceAdapter();
  const companyId = existing.report.reportIdentity.companyId;
  const periodYear = existing.report.period.periodYear;
  const before = await adapter.normalize({ companyId, periodYear, reviewedAccountLines });
  const target = before.facts.find((f) => f.factId === decision.factId);
  if (!target || target.provenance.locator.kind !== "TRIAL_BALANCE_ROW" || !target.factId.startsWith("fact:detail:")) {
    throw new Error(`Fact "${decision.factId}" is a derived figure, not a source figure — correct the underlying account instead.`);
  }
  const locator = target.provenance.locator;
  const periodId = target.reportingPeriod.periodId;
  const matches = reviewedAccountLines.filter((l) => (l.accountCode ?? l.accountKey) === locator.accountCode && l.periodId === periodId);
  if (matches.length !== 1) throw new Error(`Cannot identify the source account for fact "${decision.factId}" unambiguously.`);

  const corrected = Number(formatMoney(decision.correctedValue));
  const modified = reviewedAccountLines.map((l) => (l === matches[0] ? { ...l, balance: corrected } : l));
  const after = await adapter.normalize({ companyId, periodYear, reviewedAccountLines: modified });

  const latest = indexLatestFacts(existing.report.facts);
  const changed = after.facts
    .filter((f) => f.factId !== decision.factId)
    .filter((f) => {
      const cur = latest.get(f.factId);
      return !!cur && !!cur.value && !!f.value && cur.value.minorUnits !== f.value.minorUnits;
    })
    .sort((a, b) => a.factId.localeCompare(b.factId));

  let state: CanonicalReviewState = { report: existing.report, decisions: existing.decisions };
  state = recordFactCorrection(state, decision, provenance);
  let n = 0;
  for (const fact of changed) {
    n += 1;
    const cur = indexLatestFacts(state.report.facts).get(fact.factId)!;
    const step: CorrectFactDecision = {
      decisionId: `${decision.decisionId}:recast:${n}`,
      decisionType: "CORRECT_FACT",
      reviewerId: decision.reviewerId,
      decidedAt: decision.decidedAt,
      factId: fact.factId,
      supersedesVersion: cur.version,
      newVersion: cur.version + 1,
      correctedValue: fact.value,
      rationale: `Re-derived from corrected figure ${decision.factId} (decision ${decision.decisionId}): ${decision.rationale}`,
      expectedReportVersion: state.report.reportIdentity.reportVersion,
    };
    state = recordFactCorrection(state, step, { ...provenance, locator: { kind: "MANUAL", note: `Recast after correction ${decision.decisionId}` }, originalText: formatMoney(fact.value!) });
  }

  const snapshot: StoredReportSnapshot = { report: state.report, decisions: state.decisions };
  await repo.saveReport(snapshot);
  return snapshot;
}
