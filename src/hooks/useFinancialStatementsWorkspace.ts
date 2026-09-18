/**
 * useFinancialStatementsWorkspace — assembles the whole workspace model
 * (sources, structure, composition, canonical report, evaluation, note
 * numbering, findings, persistence state) from workspace inputs.
 *
 * Reads only. It never writes a financial table: the report, evaluations and
 * reviewer decisions live in an in-memory repository for this session, and
 * the persistence state says so (Iron Dome 4.2 — persisted writes are an Edge
 * Function concern and are gated off by FINANCIAL_STATEMENT_PERSISTENCE_ENABLED
 * in this branch, which contains no database schema or write path). `loadAccountMappings` is injectable so a
 * non-production harness can run the real component tree without a database.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { DOCUMENT_REVIEW_ENABLED } from "@/lib/product/outcomes";
import { evaluateReport, correctFactAndRecast, prepareTrialBalanceReport, recordReviewerDecision, StaleTrialBalanceInputError } from "@/lib/financialStatementsWorkspace/evaluationOrchestrator";
import { AdapterRejectedError } from "@/lib/financialStatementsWorkspace/adapterContract";
import { InMemoryFinancialStatementReportRepository, type EvaluationRunRecord, type StoredReportSnapshot } from "@/lib/financialStatementsWorkspace/reportRepository";
import { mapWorkspaceTrialBalanceToReviewedLines, type AccountMappingRow, type AmbiguousAccount, type CanonicalStatementsLike, type UnmappedAccount } from "@/lib/financialStatementsWorkspace/mapWorkspaceTrialBalance";
import type { ReviewedTrialBalanceAccountLine } from "@/lib/financialStatementsWorkspace/trialBalanceAdapter";
import { COMPARATIVE_PERIOD_ID, resolveComparativeSource, type ComparativeCandidateUpload } from "@/lib/financialStatementsWorkspace/comparativeSource";
import { profileForDbValue, type FrameworkProfile } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { deriveReportingPeriod } from "@/lib/financialStatementsWorkspace/reportingPeriod";
import { composeStatements, type StatementComposition } from "@/lib/financialStatementsWorkspace/statementComposition";
import { buildSources, type SourceEntry } from "@/lib/financialStatementsWorkspace/sourcesModel";
import { buildStructure, type StructureModel } from "@/lib/financialStatementsWorkspace/structureModel";
import { deriveNoteNumbering, type NoteNumberingResult } from "@/lib/financialStatementsWorkspace/noteNumbering";
import { buildFindingViews, type FindingView } from "@/lib/financialStatementsWorkspace/findingsView";
import { correctableFacts } from "@/lib/financialStatementsWorkspace/correctableFacts";
import { buildDecisionCommand, DecisionCommandError, isStaleVersionError, type ReviewOutcome } from "@/lib/financialStatementsWorkspace/reviewerDecisionCommands";
import { FINANCIAL_STATEMENT_PERSISTENCE_ENABLED } from "@/lib/financialStatementsWorkspace/persistenceGate";
import { classifyPersistenceError, initialPersistenceState, type PersistenceState } from "@/lib/financialStatementsWorkspace/persistenceContract";
import type { RuleEvaluationRecord } from "@/lib/canonicalStatement/types";

export interface WorkspaceUploadInput extends ComparativeCandidateUpload {
  readonly file_name: string;
}

export type AccountMappingLoader = (companyId: string) => Promise<{ readonly rows: readonly AccountMappingRow[]; readonly error: string | null }>;

const supabaseMappingLoader: AccountMappingLoader = async (companyId) => {
  const { data, error } = await supabase
    .from("account_mappings")
    .select("account_key, account_code, account_name, normalized_account_name, statement, classification, normal_balance, is_cash_account, is_retained_earnings, is_payroll_account")
    .eq("company_id", companyId);
  return { rows: (data ?? []) as AccountMappingRow[], error: error ? error.message : null };
};

export interface WorkspaceInputs {
  readonly companyId: string;
  readonly periodYear: number;
  readonly companyName: string;
  readonly companyTin: string | null;
  readonly reportingFramework: string | null;
  readonly currency: string | null;
  readonly fiscalYearEnd: string | null;
  readonly currentUpload: WorkspaceUploadInput | null;
  readonly uploads: readonly WorkspaceUploadInput[];
  readonly loadAccountMappings?: AccountMappingLoader;
}

export type WorkspaceStatus = "loading" | "ready" | "blocked" | "error";

export interface DecisionRequest {
  readonly outcome: ReviewOutcome;
  readonly finding: RuleEvaluationRecord;
  readonly rationale: string;
  readonly correction?: { readonly factId: string; readonly correctedAmount: string };
}

export type DecisionResult = { readonly ok: true } | { readonly ok: false; readonly message: string; readonly persistence?: PersistenceState };

export interface FinancialStatementsWorkspaceModel {
  readonly status: WorkspaceStatus;
  readonly reason: string | null;
  readonly diagnostics: readonly string[];
  readonly profile: FrameworkProfile | null;
  readonly sources: readonly SourceEntry[];
  readonly structure: StructureModel;
  readonly composition: StatementComposition | null;
  readonly snapshot: StoredReportSnapshot | null;
  readonly evaluation: EvaluationRunRecord | null;
  readonly numbering: NoteNumberingResult | null;
  readonly views: readonly FindingView[];
  readonly persistence: PersistenceState;
  readonly notice: string | null;
  readonly decide: (request: DecisionRequest) => Promise<DecisionResult>;
  readonly rerun: () => void;
}

const SESSION_REVIEWER_ID = "draft-session-reviewer";

export function useFinancialStatementsWorkspace(inputs: WorkspaceInputs): FinancialStatementsWorkspaceModel {
  const loader = inputs.loadAccountMappings ?? supabaseMappingLoader;
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [reason, setReason] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly string[]>([]);
  const [snapshot, setSnapshot] = useState<StoredReportSnapshot | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationRunRecord | null>(null);
  const [mappingInfo, setMappingInfo] = useState<{ total: number; unmapped: readonly UnmappedAccount[]; ambiguous: readonly AmbiguousAccount[]; cashReviewed: boolean } | null>(null);
  const [persistence, setPersistence] = useState<PersistenceState>(initialPersistenceState());
  const [notice, setNotice] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const repoRef = useRef(new InMemoryFinancialStatementReportRepository());
  const linesRef = useRef<readonly ReviewedTrialBalanceAccountLine[]>([]);
  const signatureRef = useRef<string | null>(null);

  const profile = useMemo(() => profileForDbValue(inputs.reportingFramework), [inputs.reportingFramework]);
  const period = useMemo(() => deriveReportingPeriod(inputs.periodYear, inputs.fiscalYearEnd), [inputs.periodYear, inputs.fiscalYearEnd]);
  const comparative = useMemo(() => resolveComparativeSource(inputs.uploads, inputs.companyId, inputs.periodYear), [inputs.uploads, inputs.companyId, inputs.periodYear]);
  const rerun = useCallback(() => setGeneration((g) => g + 1), []);

  const statementsOf = (upload: WorkspaceUploadInput | null): CanonicalStatementsLike | null => {
    const raw = upload?.processing_result as { statements?: CanonicalStatementsLike } | CanonicalStatementsLike | null | undefined;
    if (!raw) return null;
    if ("statements" in raw && raw.statements) return raw.statements;
    if ("balance_sheet" in raw || "income_statement" in raw) return raw as CanonicalStatementsLike;
    return null;
  };

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setStatus("loading");
      setReason(null);
      setDiagnostics([]);

      const current = inputs.currentUpload;
      const currentStatements = statementsOf(current);
      if (!current || !currentStatements) {
        setMappingInfo(null);
        setSnapshot(null);
        setEvaluation(null);
        setStatus("blocked");
        setReason("No processed trial balance is available for this period yet.");
        return;
      }
      const { rows, error } = await loader(inputs.companyId);
      if (cancelled) return;
      if (error) {
        setStatus("error");
        setReason(`Could not load account mappings: ${error}`);
        return;
      }

      const currentMapped = mapWorkspaceTrialBalanceToReviewedLines({ statements: currentStatements, accountMappings: rows, currency: inputs.currency ?? "", sourceUploadId: current.id });
      let comparativeLines: readonly ReviewedTrialBalanceAccountLine[] = [];
      if (comparative.state === "AVAILABLE") {
        const m = mapWorkspaceTrialBalanceToReviewedLines({ statements: statementsOf(comparative.upload), accountMappings: rows, currency: inputs.currency ?? "", sourceUploadId: comparative.upload.id, periodId: COMPARATIVE_PERIOD_ID });
        comparativeLines = m.lines;
      }
      const lines = [...currentMapped.lines, ...comparativeLines];
      linesRef.current = lines;
      setMappingInfo({
        total: currentMapped.totalAccounts,
        unmapped: currentMapped.unmappedAccounts,
        ambiguous: currentMapped.ambiguousAccounts,
        cashReviewed: currentMapped.lines.some((l) => l.isCashAccount === true),
      });

      if (profile && profile.trialBalance.status === "UNSUPPORTED") {
        setSnapshot(null);
        setEvaluation(null);
        setStatus("ready");
        return;
      }
      if (!profile || !inputs.currency) {
        setSnapshot(null);
        setEvaluation(null);
        setStatus("blocked");
        setReason(!profile ? "Choose a reporting framework before statements can be prepared." : "Set the presentation currency before statements can be prepared.");
        return;
      }
      if (currentMapped.lines.length === 0) {
        setSnapshot(null);
        setEvaluation(null);
        setStatus("blocked");
        setReason("None of this trial balance's accounts have a usable reviewed mapping yet.");
        return;
      }

      // Same source data => keep the session's draft (and any decisions in it); changed data => a fresh draft.
      const signature = sha256Hex(canonicalStringify({ c: inputs.companyId, y: inputs.periodYear, f: inputs.reportingFramework, cur: inputs.currency, lines: lines.map((l) => [l.accountKey, l.periodId, l.balance, l.classification, l.statement]) }));
      if (signatureRef.current !== null && signatureRef.current !== signature) {
        const had = (await repoRef.current.getLatestByCompanyPeriod(inputs.companyId, inputs.periodYear, "TRIAL_BALANCE_DERIVED"))?.decisions.length ?? 0;
        repoRef.current = new InMemoryFinancialStatementReportRepository();
        setNotice(had > 0 ? "The source data changed, so the previous draft review decisions were discarded." : null);
      }
      signatureRef.current = signature;

      try {
        const priorYear = inputs.periodYear - 1;
        const priorBounds = deriveReportingPeriod(priorYear, inputs.fiscalYearEnd);
        const prepared = await prepareTrialBalanceReport(
          {
            companyId: inputs.companyId,
            periodYear: inputs.periodYear,
            entityLegalName: inputs.companyName,
            taxIdentificationNumber: inputs.companyTin ?? undefined,
            framework: inputs.reportingFramework,
            currency: inputs.currency,
            currentPeriod: { startDate: period.startDate, endDate: period.endDate },
            comparativePeriods: comparativeLines.length > 0 ? [{ periodId: COMPARATIVE_PERIOD_ID, startDate: priorBounds.startDate, endDate: priorBounds.endDate, periodYear: priorYear, isRestated: false }] : [],
            reviewedAccountLines: lines,
          },
          repoRef.current,
        );
        if (cancelled) return;
        const run = await evaluateReport(prepared.snapshot, repoRef.current);
        if (cancelled) return;
        setSnapshot(prepared.snapshot);
        setEvaluation(run);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setSnapshot(null);
        setEvaluation(null);
        if (err instanceof AdapterRejectedError) {
          setStatus("error");
          setReason("The reviewed trial balance could not be converted into statements.");
          setDiagnostics(err.diagnostics.map((d) => `[${d.code}] ${d.message}`));
        } else if (err instanceof StaleTrialBalanceInputError) {
          setStatus("error");
          setReason("The draft no longer matches the source data. Re-run to start a fresh draft.");
          repoRef.current = new InMemoryFinancialStatementReportRepository();
          signatureRef.current = null;
        } else {
          setStatus("error");
          setReason(err instanceof Error ? err.message : String(err));
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.companyId, inputs.periodYear, inputs.currentUpload, comparative, inputs.reportingFramework, inputs.currency, inputs.fiscalYearEnd, inputs.companyName, inputs.companyTin, generation]);

  const decide = useCallback(
    async (request: DecisionRequest): Promise<DecisionResult> => {
      if (!snapshot) return { ok: false, message: "There is no prepared report to review." };
      try {
        const command = buildDecisionCommand({
          ...request,
          correctableFactIds: correctableFacts(snapshot.report, request.finding).map((c) => c.factId),
          report: snapshot.report,
          decisionId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `decision-${Date.now()}-${Math.random()}`,
          decidedAt: new Date().toISOString(),
          reviewerId: SESSION_REVIEWER_ID,
        });
        const repo = repoRef.current;
        let next: StoredReportSnapshot;
        if (command.kind === "CORRECTION") {
          next = await correctFactAndRecast({ reportId: snapshot.report.reportIdentity.reportId, decision: command.decision, provenance: command.provenance, reviewedAccountLines: linesRef.current, repo });
        } else {
          await recordReviewerDecision(snapshot.report.reportIdentity.reportId, command.decision as never, repo);
          next = (await repo.getByReportId(snapshot.report.reportIdentity.reportId))!;
        }
        const run = await evaluateReport(next, repo);
        setSnapshot(next);
        setEvaluation(run);
        // Persisted saving is gated off; the decision exists only in this session's draft.
        setPersistence(FINANCIAL_STATEMENT_PERSISTENCE_ENABLED ? "UNSAVED_DRAFT" : "UNAVAILABLE");
        return { ok: true };
      } catch (err) {
        if (err instanceof DecisionCommandError) return { ok: false, message: err.message };
        if (isStaleVersionError(err)) {
          setPersistence("STALE_VERSION");
          return { ok: false, message: "The report changed since you opened this decision. Re-run validation and try again.", persistence: "STALE_VERSION" };
        }
        const state = classifyPersistenceError(err);
        setPersistence(state);
        return { ok: false, message: err instanceof Error ? err.message : String(err), persistence: state };
      }
    },
    [snapshot],
  );

  const views = useMemo(() => (evaluation && snapshot ? buildFindingViews(evaluation.findings, snapshot.decisions) : []), [evaluation, snapshot]);
  const numbering = useMemo(() => (snapshot ? deriveNoteNumbering(snapshot.report) : null), [snapshot]);

  const composition = useMemo(
    () => (profile ? composeStatements({ profile, report: snapshot?.report ?? null, comparativeAvailable: comparative.state === "AVAILABLE" && (!snapshot || snapshot.report.comparativePeriods.length > 0), cashPerimeterReviewed: mappingInfo?.cashReviewed ?? false }) : null),
    [profile, snapshot, comparative, mappingInfo],
  );

  const sources = useMemo(
    () =>
      buildSources({
        currentUpload: inputs.currentUpload ? { id: inputs.currentUpload.id, file_name: inputs.currentUpload.file_name, status: inputs.currentUpload.status, is_valid: inputs.currentUpload.is_valid } : null,
        periodYear: inputs.periodYear,
        comparative,
        documentReviewEnabled: DOCUMENT_REVIEW_ENABLED,
      }),
    [inputs.currentUpload, inputs.periodYear, comparative],
  );

  const structure = useMemo(
    () =>
      buildStructure({
        profile,
        rawFramework: inputs.reportingFramework,
        currency: inputs.currency,
        periodYear: inputs.periodYear,
        period,
        comparativePeriodYear: inputs.periodYear - 1,
        comparativeAvailable: comparative.state === "AVAILABLE" && (!snapshot || snapshot.report.comparativePeriods.length > 0),
        composition,
        mapping: mappingInfo ? { totalAccounts: mappingInfo.total, unmapped: mappingInfo.unmapped, ambiguous: mappingInfo.ambiguous } : null,
      }),
    [profile, inputs.reportingFramework, inputs.currency, inputs.periodYear, period, comparative, snapshot, composition, mappingInfo],
  );

  return { status, reason, diagnostics, profile, sources, structure, composition, snapshot, evaluation, numbering, views, persistence, notice, decide, rerun };
}
