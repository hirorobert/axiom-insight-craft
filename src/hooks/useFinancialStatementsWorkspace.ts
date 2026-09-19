/**
 * useFinancialStatementsWorkspace — assembles the whole workspace model
 * (sources, evidence, structure, composition, canonical report, evaluation, note
 * numbering, findings, persistence state) from workspace inputs.
 *
 * Financial writes never happen here (Iron Dome 4.2). The working report, evidence
 * and reviewer decisions live in this session; saving is delegated to
 * saveWorkspace() over FsRpcTransport — SECURITY DEFINER RPCs that derive the actor
 * from the caller's own JWT. A transport exists only when the source-controlled
 * persistence gate is on, and even then the server decides (default-denied rollout,
 * kill switch). `loadAccountMappings` and `transport` are injectable so the
 * non-production harness can run the real component tree without a hosted project.
 *
 * Model: base report (from the reviewed trial balance) + validated evidence
 * => effective report (statements, notes, schedules) => rule pack v2 => findings.
 * A fact correction applies to the trial-balance base only; evidence is corrected at
 * source by uploading a new version of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { DOCUMENT_REVIEW_ENABLED } from "@/lib/product/outcomes";
import { correctFactAndRecast, evaluateReportPure, prepareTrialBalanceReport, recordReviewerDecision, StaleTrialBalanceInputError } from "@/lib/financialStatementsWorkspace/evaluationOrchestrator";
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
import { createWorkspaceTransport } from "@/lib/financialStatementsWorkspace/supabaseFsBackend";
import { FsTransportError, type FsRpcTransport, type PublicationRow, type ReportReadiness, type SavedVersionSummary, type WorkspaceAccess } from "@/lib/financialStatementsWorkspace/rpcTransport";
import { generatedFromStoredReport, historicalView, restoreLatestDraft, type HistoricalView } from "@/lib/financialStatementsWorkspace/savedVersions";
import { buildLineage, outputReportFor, versionLabelOf, type ExportLineage } from "@/lib/financialStatementsWorkspace/exports";
import { budgetFromReport, checklistFromReport } from "@/lib/financialGeneration/persistedAuthority";
import type { CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";
import { saveWorkspace, type SavedState } from "@/lib/financialStatementsWorkspace/saveFlow";
import type { CorrectEvidenceDecision, ReviewerDecision, RuleEvaluationRecord } from "@/lib/canonicalStatement/types";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import { ingestEvidence, classifyReplay, type IntakeCommon } from "@/lib/financialEvidence/intake";
import { ingestWorkbook, type WorkbookSheetInfo } from "@/lib/financialEvidence/xlsx";
import { correctEvidenceCell } from "@/lib/financialEvidence/correction";
import type { EvidenceBatch, EvidenceDiagnostic, EvidenceType, PeriodRole, ReplayStatus } from "@/lib/financialEvidence/types";
import { applyEvidence, evidenceOnlyReport, latestPerSeries, type ApplyEvidenceResult, type StoredEvidence } from "@/lib/financialGeneration/applyEvidence";

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
  /** Injected in the non-production harness; in production it is created only when the persistence gate is on. */
  readonly transport?: FsRpcTransport | null;
}

export type WorkspaceStatus = "loading" | "ready" | "blocked" | "error";

export interface DecisionRequest {
  readonly outcome: ReviewOutcome;
  readonly finding: RuleEvaluationRecord;
  readonly rationale: string;
  readonly correction?: { readonly factId: string; readonly correctedAmount: string };
}

export type DecisionResult = { readonly ok: true } | { readonly ok: false; readonly message: string; readonly persistence?: PersistenceState };

export type SaveStatus = "DISABLED" | "DENIED" | "CHECKING" | "CLEAN" | "UNSAVED" | "SAVING" | "SAVED" | "CONFLICT" | "ERROR";

export interface EvidenceAddRequest {
  readonly evidenceType: EvidenceType;
  readonly periodRole: PeriodRole;
  readonly fileName?: string;
  readonly mimeType?: string;
  /** CSV text. Absent when `bytes` is supplied. */
  readonly text?: string;
  /** The bytes of an .xlsx workbook. The sheet is never chosen for the user: `sheetName` is required to proceed. */
  readonly bytes?: Uint8Array;
  readonly sheetName?: string;
  readonly currency?: string;
  readonly scale?: number;
  readonly seriesKey?: string;
}

export type EvidenceAddResult =
  | { readonly kind: "ADDED"; readonly batch: EvidenceBatch; readonly replay: ReplayStatus; readonly diagnostics: readonly EvidenceDiagnostic[] }
  | { readonly kind: "EXACT_REPLAY"; readonly batch: EvidenceBatch; readonly replay: ReplayStatus; readonly diagnostics: readonly EvidenceDiagnostic[] }
  | { readonly kind: "SHEET_SELECTION_REQUIRED"; readonly sheets: readonly WorkbookSheetInfo[]; readonly diagnostics: readonly EvidenceDiagnostic[] }
  | { readonly kind: "REJECTED"; readonly diagnostics: readonly EvidenceDiagnostic[] };

export type RestoreStatus = "IDLE" | "LOADING" | "NOTHING_SAVED" | "RESTORED" | "DIVERGED" | "ERROR";
export interface RestoreState {
  readonly status: RestoreStatus;
  readonly message: string | null;
}

const VIEWER_MESSAGE = "Read-only access: your role is viewer, so you can read this workspace but not change, save, review or finalise anything.";
const READ_ONLY_MESSAGE = (v: number) => `You are viewing saved version ${v} read-only. Return to the working draft to make changes.`;

export interface EvidenceCorrectionRequest {
  readonly evidenceBatchId: string;
  readonly rowNumber: number;
  readonly column: string;
  readonly newValue: string;
  readonly rationale: string;
}

export type EvidenceCorrectionOutcome =
  | { readonly ok: true; readonly mode: "RECORDED" | "REPLACED_UNSAVED"; readonly batch: EvidenceBatch; readonly message: string }
  | { readonly ok: false; readonly message: string; readonly diagnostics: readonly EvidenceDiagnostic[] };

export interface EvidenceEntry {
  readonly batch: EvidenceBatch;
  readonly version: number;
  readonly saved: boolean;
  /** Whether the latest version of its series currently feeds a statement, with the reason. */
  readonly used: boolean;
  readonly useReason: string;
}

export interface FinancialStatementsWorkspaceModel {
  readonly status: WorkspaceStatus;
  readonly reason: string | null;
  readonly diagnostics: readonly string[];
  readonly profile: FrameworkProfile | null;
  readonly sources: readonly SourceEntry[];
  readonly structure: StructureModel;
  readonly composition: StatementComposition | null;
  /** The EFFECTIVE report (trial-balance base plus validated evidence) and the decisions recorded against it. */
  readonly snapshot: StoredReportSnapshot | null;
  readonly evaluation: EvaluationRunRecord | null;
  readonly numbering: NoteNumberingResult | null;
  readonly views: readonly FindingView[];
  readonly persistence: PersistenceState;
  readonly notice: string | null;
  readonly decide: (request: DecisionRequest) => Promise<DecisionResult>;
  readonly rerun: () => void;
  // evidence
  readonly evidence: readonly EvidenceEntry[];
  readonly applied: ApplyEvidenceResult | null;
  /** The disclosure checklist being shown: for a stored version, the one recorded IN that version (never today's evidence). */
  readonly checklist: ApplyEvidenceResult["checklist"];
  /** Live row-level drill-down and cash-perimeter detail; both are empty while a stored version is shown, since they can only be derived from live evidence. */
  readonly evidenceIndex: ApplyEvidenceResult["evidenceIndex"];
  readonly cashPerimeter: ApplyEvidenceResult["cashPerimeter"];
  /** The budget comparison being shown: for a stored version, the one recorded IN that version. */
  readonly budgetComparison: ApplyEvidenceResult["budgetActual"];
  readonly addEvidence: (request: EvidenceAddRequest) => EvidenceAddResult;
  readonly removeUnsavedEvidence: (evidenceBatchId: string) => void;
  /** Corrects one cell of the latest version of an evidence series: a new evidence version, never an edit. */
  readonly correctEvidence: (request: EvidenceCorrectionRequest) => EvidenceCorrectionOutcome;
  // saving
  readonly saveStatus: SaveStatus;
  readonly saveMessage: string | null;
  readonly access: WorkspaceAccess | null;
  readonly storedVersion: number | null;
  readonly save: () => Promise<void>;
  // reopening saved work
  readonly restore: RestoreState;
  readonly versions: readonly SavedVersionSummary[];
  /** Non-null while a stored version is displayed read-only. */
  readonly viewing: HistoricalView | null;
  /** True while a stored version is shown, and for a viewer: every mutating control is then unavailable. */
  readonly readOnly: boolean;
  /** True when the server reports the caller's role as viewer (the workspace is read-only for them, whatever version is shown). */
  readonly readOnlyAccess: boolean;
  readonly openVersion: (reportVersion: number) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly closeVersion: () => void;
  /** Discards the local draft and re-reads the server's latest saved version (the way out of a save conflict). */
  readonly reloadFromServer: () => void;
  /** The server's own readiness answer for the stored latest version (a preview; publication re-checks it). */
  readonly readiness: ReportReadiness | null;
  /** The persisted report version being shown, or null for unsaved work. Never a transient counter. */
  readonly persistedVersion: number | null;
  /** "Version N" for persisted work, exactly "Unsaved draft" otherwise. */
  readonly versionLabel: string;
  /** What print and every export are rendered from: one report, one evaluation, one lineage. */
  readonly output: { readonly report: CanonicalFinancialStatementReport; readonly evaluation: EvaluationRunRecord | null; readonly lineage: ExportLineage } | null;
  readonly publication: PublicationRow | null;
  readonly setPublication: (state: "DRAFT" | "REVIEWED" | "FINAL", reason: string) => Promise<{ readonly ok: boolean; readonly message: string }>;
}

const SESSION_REVIEWER_ID = "draft-session-reviewer";
const STORED_FINDING_TIMESTAMP = () => "1970-01-01T00:00:00.000Z";

export function useFinancialStatementsWorkspace(inputs: WorkspaceInputs): FinancialStatementsWorkspaceModel {
  const loader = inputs.loadAccountMappings ?? supabaseMappingLoader;
  const transport = useMemo(() => (inputs.transport !== undefined ? inputs.transport : createWorkspaceTransport()), [inputs.transport]);
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [reason, setReason] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly string[]>([]);
  const [baseSnapshot, setBaseSnapshot] = useState<StoredReportSnapshot | null>(null);
  const [mappingInfo, setMappingInfo] = useState<{ total: number; unmapped: readonly UnmappedAccount[]; ambiguous: readonly AmbiguousAccount[]; cashReviewed: boolean; cashAccountKeys: readonly string[] } | null>(null);
  const [persistence, setPersistence] = useState<PersistenceState>(initialPersistenceState());
  const [notice, setNotice] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [evidenceStore, setEvidenceStore] = useState<readonly (StoredEvidence & { readonly saved: boolean })[]>([]);
  const [decisionRevision, setDecisionRevision] = useState(0);
  const [evidenceCorrections, setEvidenceCorrections] = useState<readonly CorrectEvidenceDecision[]>([]);
  const [restore, setRestore] = useState<RestoreState>({ status: "IDLE", message: null });
  const [versions, setVersions] = useState<readonly SavedVersionSummary[]>([]);
  const [viewing, setViewing] = useState<HistoricalView | null>(null);
  const [readiness, setReadiness] = useState<ReportReadiness | null>(null);
  const [restoreNonce, setRestoreNonce] = useState(0);
  const [access, setAccess] = useState<WorkspaceAccess | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(FINANCIAL_STATEMENT_PERSISTENCE_ENABLED || inputs.transport ? "CHECKING" : "DISABLED");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [storedVersion, setStoredVersion] = useState<number | null>(null);
  const [publication, setPublicationRow] = useState<PublicationRow | null>(null);

  const repoRef = useRef(new InMemoryFinancialStatementReportRepository());
  const linesRef = useRef<readonly ReviewedTrialBalanceAccountLine[]>([]);
  const signatureRef = useRef<string | null>(null);
  const savedRef = useRef<SavedState | null>(null);
  const savedKeyRef = useRef<string | null>(null);
  const restoredKeyRef = useRef<string | null>(null);
  const markSavedRef = useRef(false);

  const profile = useMemo(() => profileForDbValue(inputs.reportingFramework), [inputs.reportingFramework]);
  const period = useMemo(() => deriveReportingPeriod(inputs.periodYear, inputs.fiscalYearEnd), [inputs.periodYear, inputs.fiscalYearEnd]);
  const priorPeriod = useMemo(() => deriveReportingPeriod(inputs.periodYear - 1, inputs.fiscalYearEnd), [inputs.periodYear, inputs.fiscalYearEnd]);
  const comparative = useMemo(() => resolveComparativeSource(inputs.uploads, inputs.companyId, inputs.periodYear), [inputs.uploads, inputs.companyId, inputs.periodYear]);
  const rerun = useCallback(() => setGeneration((g) => g + 1), []);

  const statementsOf = (upload: WorkspaceUploadInput | null): CanonicalStatementsLike | null => {
    const raw = upload?.processing_result as { statements?: CanonicalStatementsLike } | CanonicalStatementsLike | null | undefined;
    if (!raw) return null;
    if ("statements" in raw && raw.statements) return raw.statements;
    if ("balance_sheet" in raw || "income_statement" in raw) return raw as CanonicalStatementsLike;
    return null;
  };

  const viewerReadOnly = access?.enabled === true && access.role === "viewer";

  // Server-authoritative access: the workspace's saving surface follows what the server says, never a client flag.
  useEffect(() => {
    let cancelled = false;
    if (!transport) {
      setAccess(null);
      setSaveStatus("DISABLED");
      return;
    }
    setSaveStatus("CHECKING");
    void transport.access(inputs.companyId).then((a) => {
      if (cancelled) return;
      setAccess(a);
      setSaveStatus(a.enabled ? "CLEAN" : a.reason === "NOT_A_MEMBER" ? "DENIED" : "DISABLED");
    });
    return () => {
      cancelled = true;
    };
  }, [transport, inputs.companyId]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setStatus("loading");
      setReason(null);
      setDiagnostics([]);

      const current = inputs.currentUpload;
      const currentStatements = statementsOf(current);
      const cashBasisEvidenceOnly = !!profile && profile.trialBalance.status === "UNSUPPORTED";
      if ((!current || !currentStatements) && !cashBasisEvidenceOnly) {
        setMappingInfo(null);
        setBaseSnapshot(null);
        setStatus("blocked");
        setReason("No processed trial balance is available for this period yet.");
        return;
      }

      let currentMapped: ReturnType<typeof mapWorkspaceTrialBalanceToReviewedLines> | null = null;
      let comparativeLines: readonly ReviewedTrialBalanceAccountLine[] = [];
      if (current && currentStatements) {
        const { rows, error } = await loader(inputs.companyId);
        if (cancelled) return;
        if (error) {
          setStatus("error");
          setReason(`Could not load account mappings: ${error}`);
          return;
        }
        currentMapped = mapWorkspaceTrialBalanceToReviewedLines({ statements: currentStatements, accountMappings: rows, currency: inputs.currency ?? "", sourceUploadId: current.id });
        if (comparative.state === "AVAILABLE") {
          const m = mapWorkspaceTrialBalanceToReviewedLines({ statements: statementsOf(comparative.upload), accountMappings: rows, currency: inputs.currency ?? "", sourceUploadId: comparative.upload.id, periodId: COMPARATIVE_PERIOD_ID });
          comparativeLines = m.lines;
        }
        linesRef.current = [...currentMapped.lines, ...comparativeLines];
        setMappingInfo({
          total: currentMapped.totalAccounts,
          unmapped: currentMapped.unmappedAccounts,
          ambiguous: currentMapped.ambiguousAccounts,
          cashReviewed: currentMapped.lines.some((l) => l.isCashAccount === true),
          cashAccountKeys: [...new Set(currentMapped.lines.filter((l) => l.isCashAccount === true && l.statement === "balance_sheet").map((l) => l.accountKey))],
        });
      }

      if (cashBasisEvidenceOnly) {
        // A cash-basis primary statement has no trial-balance route: it is built from evidence alone.
        setBaseSnapshot(null);
        setStatus("ready");
        return;
      }
      if (!profile || !inputs.currency) {
        setBaseSnapshot(null);
        setStatus("blocked");
        setReason(!profile ? "Choose a reporting framework before statements can be prepared." : "Set the presentation currency before statements can be prepared.");
        return;
      }
      if (!currentMapped || currentMapped.lines.length === 0) {
        setBaseSnapshot(null);
        setStatus("blocked");
        setReason("None of this trial balance's accounts have a usable reviewed mapping yet.");
        return;
      }

      const lines = linesRef.current;
      // Same source data => keep the session's draft (and any decisions in it); changed data => a fresh draft.
      const signature = sha256Hex(canonicalStringify({ c: inputs.companyId, y: inputs.periodYear, f: inputs.reportingFramework, cur: inputs.currency, lines: lines.map((l) => [l.accountKey, l.periodId, l.balance, l.classification, l.statement]) }));
      if (signatureRef.current !== null && signatureRef.current !== signature) {
        const had = (await repoRef.current.getLatestByCompanyPeriod(inputs.companyId, inputs.periodYear, "TRIAL_BALANCE_DERIVED"))?.decisions.length ?? 0;
        repoRef.current = new InMemoryFinancialStatementReportRepository();
        savedRef.current = null;
        setNotice(had > 0 ? "The source data changed, so the previous draft review decisions were discarded." : null);
      }
      signatureRef.current = signature;

      try {
        const priorYear = inputs.periodYear - 1;
        const prepared = await prepareTrialBalanceReport(
          {
            companyId: inputs.companyId,
            periodYear: inputs.periodYear,
            entityLegalName: inputs.companyName,
            taxIdentificationNumber: inputs.companyTin ?? undefined,
            framework: inputs.reportingFramework,
            currency: inputs.currency,
            currentPeriod: { startDate: period.startDate, endDate: period.endDate },
            comparativePeriods: comparativeLines.length > 0 ? [{ periodId: COMPARATIVE_PERIOD_ID, startDate: priorPeriod.startDate, endDate: priorPeriod.endDate, periodYear: priorYear, isRestated: false }] : [],
            reviewedAccountLines: lines,
          },
          repoRef.current,
        );
        if (cancelled) return;
        setBaseSnapshot(prepared.snapshot);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setBaseSnapshot(null);
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

  // ── evidence → effective report ─────────────────────────────────────────
  const latestEvidence = useMemo(() => latestPerSeries(evidenceStore), [evidenceStore]);

  /** The empty report a cash-basis (evidence-only) statement set is folded into. Depends only on the evidence set's scale and comparative presence. */
  const evidenceOnlyShellFor = useCallback(
    (set: readonly EvidenceBatch[]) =>
      profile && inputs.currency
        ? evidenceOnlyReport({
            reportId: sha256Hex(canonicalStringify({ companyId: inputs.companyId, periodYear: inputs.periodYear, kind: "evidence-only-report", framework: profile.kind })),
            companyId: inputs.companyId,
            entityName: inputs.companyName,
            periodYear: inputs.periodYear,
            startDate: period.startDate,
            endDate: period.endDate,
            framework: { kind: profile.kind },
            currency: inputs.currency,
            scale: set.find((b) => b.scale !== null)?.scale ?? 2,
            comparativeYear: set.some((b) => b.periodRole === "COMPARATIVE") ? inputs.periodYear - 1 : undefined,
          })
        : null,
    [profile, inputs.currency, inputs.companyId, inputs.companyName, inputs.periodYear, period],
  );

  /** How many trial-balance accounts were reviewed / unmapped / ambiguous: recorded in the report so the database can see it. */
  const mappingCoverage = useMemo(() => (mappingInfo ? { total: mappingInfo.total, unmapped: mappingInfo.unmapped.length, ambiguous: mappingInfo.ambiguous.length } : undefined), [mappingInfo]);

  const applied = useMemo<ApplyEvidenceResult | null>(() => {
    if (!profile) return null;
    if (baseSnapshot) return applyEvidence({ report: baseSnapshot.report, profile, evidence: latestEvidence, cashAccountKeys: mappingInfo?.cashAccountKeys ?? [], mappingCoverage });
    if (profile.trialBalance.status === "UNSUPPORTED") {
      const shell = evidenceOnlyShellFor(latestEvidence);
      return shell ? applyEvidence({ report: shell, profile, evidence: latestEvidence }) : null;
    }
    return null;
  }, [profile, baseSnapshot, latestEvidence, mappingInfo, mappingCoverage, evidenceOnlyShellFor]);

  const decisionLog = useMemo<readonly ReviewerDecision[]>(() => baseSnapshot?.decisions ?? [], [baseSnapshot]);
  const snapshot = useMemo<StoredReportSnapshot | null>(() => {
    const report = applied?.report ?? baseSnapshot?.report ?? null;
    return report ? { report, decisions: decisionLog } : null;
  }, [applied, baseSnapshot, decisionLog]);

  const evaluation = useMemo<EvaluationRunRecord | null>(() => (snapshot ? evaluateReportPure(snapshot.report, ZERO_TOLERANCE) : null), [snapshot]);

  const decide = useCallback(
    async (request: DecisionRequest): Promise<DecisionResult> => {
      if (viewerReadOnly) return { ok: false, message: VIEWER_MESSAGE };
      if (viewing) return { ok: false, message: READ_ONLY_MESSAGE(viewing.reportVersion) };
      if (!snapshot) return { ok: false, message: "There is no prepared report to review." };
      try {
        const reportId = snapshot.report.reportIdentity.reportId;
        const repo = repoRef.current;
        if (!(await repo.getByReportId(reportId))) await repo.saveReport({ report: snapshot.report, decisions: [] }); // evidence-only report: register it so decisions can be appended
        const stored = (await repo.getByReportId(reportId))!;
        const command = buildDecisionCommand({
          ...request,
          correctableFactIds: baseSnapshot ? correctableFacts(baseSnapshot.report, request.finding).map((c) => c.factId) : [],
          report: baseSnapshot ? baseSnapshot.report : snapshot.report,
          decisionId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `decision-${Date.now()}-${Math.random()}`,
          decidedAt: new Date().toISOString(),
          reviewerId: SESSION_REVIEWER_ID,
        });
        if (command.kind === "CORRECTION") {
          if (!baseSnapshot) return { ok: false, message: "A source figure can only be corrected on a trial-balance-derived report. Correct evidence by uploading a new version of it." };
          const next = await correctFactAndRecast({ reportId, decision: command.decision, provenance: command.provenance, reviewedAccountLines: linesRef.current, repo });
          setBaseSnapshot(next);
        } else {
          await recordReviewerDecision(reportId, command.decision as never, repo);
          const after = (await repo.getByReportId(reportId))!;
          if (baseSnapshot) setBaseSnapshot({ ...baseSnapshot, decisions: after.decisions });
          else setDecisionRevision((n) => n + 1);
        }
        void stored;
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
    [snapshot, baseSnapshot, viewing, viewerReadOnly],
  );

  // For an evidence-only report the decision log lives only in the repo; mirror it into the effective snapshot.
  const effectiveDecisions = useMemo<readonly ReviewerDecision[]>(() => decisionLog, [decisionLog]);
  const [evidenceOnlyDecisions, setEvidenceOnlyDecisions] = useState<readonly ReviewerDecision[]>([]);
  useEffect(() => {
    if (baseSnapshot || !snapshot) return;
    void repoRef.current.getByReportId(snapshot.report.reportIdentity.reportId).then((s) => setEvidenceOnlyDecisions(s?.decisions ?? []));
  }, [baseSnapshot, snapshot, decisionRevision]);
  const decisionsForViews = useMemo<readonly ReviewerDecision[]>(() => {
    const own = baseSnapshot ? effectiveDecisions : evidenceOnlyDecisions;
    if (evidenceCorrections.length === 0) return own;
    // Chronological; equal timestamps keep their original order (fact corrections before evidence corrections).
    return [...own, ...evidenceCorrections]
      .map((d, i) => ({ d, i }))
      .sort((a, b) => (a.d.decidedAt < b.d.decidedAt ? -1 : a.d.decidedAt > b.d.decidedAt ? 1 : a.i - b.i))
      .map((x) => x.d);
  }, [baseSnapshot, effectiveDecisions, evidenceOnlyDecisions, evidenceCorrections]);

  const views = useMemo(() => (evaluation ? buildFindingViews(evaluation.findings, decisionsForViews) : []), [evaluation, decisionsForViews]);
  const numbering = useMemo(() => (snapshot ? deriveNoteNumbering(snapshot.report) : null), [snapshot]);
  const modelSnapshot = useMemo<StoredReportSnapshot | null>(() => (snapshot ? { report: snapshot.report, decisions: decisionsForViews } : null), [snapshot, decisionsForViews]);

  // ── evidence actions ────────────────────────────────────────────────────
  const addEvidence = useCallback(
    (request: EvidenceAddRequest): EvidenceAddResult => {
      if (viewerReadOnly) return { kind: "REJECTED", diagnostics: [{ code: "READ_ONLY_ACCESS", severity: "ERROR", message: VIEWER_MESSAGE }] };
      if (viewing) return { kind: "REJECTED", diagnostics: [{ code: "READ_ONLY_VERSION", severity: "ERROR", message: READ_ONLY_MESSAGE(viewing.reportVersion) }] };
      const isComparative = request.periodRole === "COMPARATIVE";
      const bounds = isComparative ? priorPeriod : period;
      const intake: IntakeCommon = {
        companyId: inputs.companyId,
        evidenceType: request.evidenceType,
        periodRole: request.periodRole,
        reportingPeriodId: `FY${isComparative ? inputs.periodYear - 1 : inputs.periodYear}`,
        seriesKey: request.seriesKey,
        fileName: request.fileName,
        mimeType: request.mimeType,
        currency: request.currency,
        scale: request.scale,
        periodStart: bounds.startDate,
        periodEnd: bounds.endDate,
      };
      const result = request.bytes ? ingestWorkbook({ ...intake, bytes: request.bytes, sheetName: request.sheetName }) : ingestEvidence({ ...intake, text: request.text ?? "" });
      if (result.outcome === "REJECTED") return { kind: "REJECTED", diagnostics: result.diagnostics };
      if (result.outcome === "SHEET_SELECTION_REQUIRED") return { kind: "SHEET_SELECTION_REQUIRED", sheets: result.sheets, diagnostics: result.diagnostics };
      const batch = result.batch;
      const pendingCorrection = latestEvidence.find(
        (b) =>
          evidenceCorrections.some((c) => c.newBatchId === b.evidenceBatchId) &&
          !evidenceStore.find((s) => s.batch.evidenceBatchId === b.evidenceBatchId)?.saved &&
          b.evidenceType === batch.evidenceType && b.periodRole === batch.periodRole && b.reportingPeriodId === batch.reportingPeriodId && b.seriesKey === batch.seriesKey,
      );
      if (pendingCorrection) return { kind: "REJECTED", diagnostics: [{ code: "CORRECTION_PENDING_SAVE", severity: "ERROR", message: "This series has a correction that has not been saved yet. Save first, then upload a new version." }] };
      const replay = classifyReplay(
        batch,
        evidenceStore.map((s) => ({ evidenceBatchId: s.batch.evidenceBatchId, companyId: s.batch.companyId, evidenceType: s.batch.evidenceType, periodRole: s.batch.periodRole, reportingPeriodId: s.batch.reportingPeriodId, seriesKey: s.batch.seriesKey, replayIdentity: s.batch.replayIdentity, version: s.version, documentJson: JSON.stringify(s.batch.document) })),
      );
      if (replay.kind === "EXACT_REPLAY" || replay.kind === "CONFLICTING_REPLAY") return { kind: "EXACT_REPLAY", batch, replay, diagnostics: batch.diagnostics };
      const version = replay.kind === "NEW_VERSION" ? replay.version : 1;
      setEvidenceStore((cur) => [...cur, { batch, version, saved: false }]);
      return { kind: "ADDED", batch, replay, diagnostics: batch.diagnostics };
    },
    [viewing, viewerReadOnly, evidenceStore, latestEvidence, evidenceCorrections, inputs.companyId, inputs.periodYear, period, priorPeriod],
  );

  const removeUnsavedEvidence = useCallback((evidenceBatchId: string) => {
    if (viewing) return;
    setEvidenceStore((cur) => cur.filter((s) => s.saved || s.batch.evidenceBatchId !== evidenceBatchId));
  }, [viewing]);

  const correctEvidence = useCallback(
    (request: EvidenceCorrectionRequest): EvidenceCorrectionOutcome => {
      if (viewerReadOnly) return { ok: false, message: VIEWER_MESSAGE, diagnostics: [] };
      if (viewing) return { ok: false, message: READ_ONLY_MESSAGE(viewing.reportVersion), diagnostics: [] };
      const target = evidenceStore.find((s) => s.batch.evidenceBatchId === request.evidenceBatchId);
      if (!target) return { ok: false, message: "That evidence is not part of this report.", diagnostics: [] };
      if (!latestEvidence.some((b) => b.evidenceBatchId === request.evidenceBatchId)) return { ok: false, message: "Only the latest version of an evidence series can be corrected.", diagnostics: [] };
      const bounds = target.batch.periodRole === "COMPARATIVE" ? priorPeriod : period;
      const result = correctEvidenceCell(target.batch, request, { periodStart: bounds.startDate, periodEnd: bounds.endDate });
      if ("reason" in result) return { ok: false, message: result.reason, diagnostics: result.diagnostics };
      if (!target.saved) {
        // Nothing durable exists yet, so there is nothing to correct on the record: the draft simply holds the fixed version.
        setEvidenceStore((cur) => [...cur.filter((s) => s.batch.evidenceBatchId !== target.batch.evidenceBatchId), { batch: result.batch, version: target.version, saved: false }]);
        return { ok: true, mode: "REPLACED_UNSAVED", batch: result.batch, message: "This evidence has not been saved yet, so the corrected version replaced it in the draft." };
      }
      const decision: CorrectEvidenceDecision = {
        decisionId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `decision-${Date.now()}-${Math.random()}`,
        decisionType: "CORRECT_EVIDENCE",
        reviewerId: SESSION_REVIEWER_ID,
        decidedAt: new Date().toISOString(),
        evidenceType: target.batch.evidenceType,
        supersedesBatchId: target.batch.evidenceBatchId,
        newBatchId: result.batch.evidenceBatchId,
        rowNumber: request.rowNumber,
        column: request.column,
        previousValue: result.previousValue,
        correctedValue: request.newValue,
        rationale: request.rationale.trim(),
        expectedReportVersion: storedVersion ?? 0,
      };
      setEvidenceStore((cur) => [...cur, { batch: result.batch, version: target.version + 1, saved: false }]);
      setEvidenceCorrections((cur) => [...cur, decision]);
      setPersistence(FINANCIAL_STATEMENT_PERSISTENCE_ENABLED || transport ? "UNSAVED_DRAFT" : "UNAVAILABLE");
      return { ok: true, mode: "RECORDED", batch: result.batch, message: `Evidence corrected as version ${target.version + 1}. Save to record it with the new report version and its re-validation.` };
    },
    [viewing, viewerReadOnly, evidenceStore, latestEvidence, period, priorPeriod, storedVersion, transport],
  );

  const evidence = useMemo<readonly EvidenceEntry[]>(() => {
    const latestIds = new Set(latestEvidence.map((b) => b.evidenceBatchId));
    return evidenceStore.map((s) => {
      const use = applied?.use.find((u) => u.evidenceBatchId === s.batch.evidenceBatchId);
      return { batch: s.batch, version: s.version, saved: s.saved, used: !!use?.used, useReason: !latestIds.has(s.batch.evidenceBatchId) ? "Superseded by a newer version of this series." : (use?.reason ?? "Not used by any statement yet.") };
    });
  }, [evidenceStore, latestEvidence, applied]);

  // ── saving ──────────────────────────────────────────────────────────────
  const dirtyKey = useMemo(
    () => (snapshot ? sha256Hex(canonicalStringify({ r: snapshot.report, e: latestEvidence.map((b) => b.evidenceBatchId), d: decisionsForViews.map((d) => d.decisionId) })) : null),
    [snapshot, latestEvidence, decisionsForViews],
  );
  useEffect(() => {
    if (!dirtyKey || (saveStatus !== "CLEAN" && saveStatus !== "SAVED" && saveStatus !== "UNSAVED")) return;
    if (markSavedRef.current) {
      savedKeyRef.current = dirtyKey; // a restored session is, by construction, exactly what is stored
      markSavedRef.current = false;
    }
    const next: SaveStatus = savedKeyRef.current === dirtyKey ? "SAVED" : "UNSAVED";
    if (next !== saveStatus) setSaveStatus(next);
  }, [dirtyKey, saveStatus]);

  /** Re-composes the effective report for the correction chain: the trial-balance base minus some appended facts, plus an evidence set. */
  const rebuildAt = useCallback(
    (dropped: ReadonlySet<string>, evidenceSet: readonly EvidenceBatch[]) => {
      if (!profile) return null;
      const base = baseSnapshot?.report;
      if (base) return applyEvidence({ report: { ...base, facts: base.facts.filter((f) => !dropped.has(`${f.factId}#${f.version}`)) }, profile, evidence: evidenceSet, cashAccountKeys: mappingInfo?.cashAccountKeys ?? [], mappingCoverage }).report;
      const shell = profile.trialBalance.status === "UNSUPPORTED" ? evidenceOnlyShellFor(evidenceSet) : null;
      return shell ? applyEvidence({ report: shell, profile, evidence: evidenceSet }).report : null;
    },
    [profile, baseSnapshot, mappingInfo, mappingCoverage, evidenceOnlyShellFor],
  );

  const save = useCallback(async () => {
    if (viewing || viewerReadOnly || restore.status === "LOADING") return;
    if (!transport || !access?.enabled || !snapshot || !dirtyKey) return;
    setSaveStatus("SAVING");
    setSaveMessage(null);
    const outcome = await saveWorkspace({
      transport,
      companyId: inputs.companyId,
      reportingPeriodId: `FY${inputs.periodYear}`,
      evidence: latestEvidence,
      report: snapshot.report,
      decisions: decisionsForViews,
      evaluate: (r) => evaluateReportPure(r, ZERO_TOLERANCE, STORED_FINDING_TIMESTAMP),
      saved: savedRef.current,
      rebuild: { at: rebuildAt, allEvidence: evidenceStore },
    });
    if (outcome.status === "FAILED") {
      setSaveStatus(outcome.isConflict ? "CONFLICT" : outcome.kind === "FORBIDDEN" ? "DENIED" : outcome.kind === "FEATURE_DISABLED" ? "DISABLED" : "ERROR");
      setSaveMessage(
        outcome.kind === "FORBIDDEN"
          ? "Your role cannot save for this company (viewers and non-members are read-only). Nothing was saved."
          : outcome.kind === "FEATURE_DISABLED"
            ? "Saving is not enabled for this company yet. Nothing was saved."
            : outcome.message,
      );
      setPersistence(outcome.isConflict ? "STALE_VERSION" : outcome.kind === "FORBIDDEN" ? "PERMISSION_DENIED" : "UNAVAILABLE");
      return;
    }
    savedRef.current = { storedVersion: outcome.storedVersion, storedDecisionIds: outcome.storedDecisionIds };
    savedKeyRef.current = dirtyKey;
    setEvidenceStore((cur) => cur.map((s) => ({ ...s, saved: true })));
    setStoredVersion(outcome.storedVersion);
    setSaveStatus("SAVED");
    setPersistence("PERSISTED");
    setSaveMessage(outcome.status === "UNCHANGED" ? "Everything was already saved." : `Saved as version ${outcome.storedVersion}.`);
    void transport.listSavedVersions(inputs.companyId, inputs.periodYear).then(setVersions, () => undefined);
    try {
      const pubs = await transport.listPublications(snapshot.report.reportIdentity.reportId);
      const latest = [...pubs].filter((p) => p.reportVersion === outcome.storedVersion).sort((a, b) => b.seq - a.seq)[0] ?? null;
      setPublicationRow(latest);
    } catch {
      /* publication state is advisory here; the server is authoritative */
    }
  }, [transport, access, snapshot, dirtyKey, inputs.companyId, inputs.periodYear, latestEvidence, decisionsForViews, rebuildAt, evidenceStore, viewing, viewerReadOnly, restore.status]);

  const setPublication = useCallback(
    async (state: "DRAFT" | "REVIEWED" | "FINAL", why: string) => {
      if (viewerReadOnly) return { ok: false, message: VIEWER_MESSAGE };
      if (viewing) return { ok: false, message: READ_ONLY_MESSAGE(viewing.reportVersion) };
      if (!transport || !snapshot || storedVersion === null || saveStatus !== "SAVED") return { ok: false, message: "Save the report first: a state can only be recorded against a saved version." };
      try {
        const row = await transport.setPublicationState(snapshot.report.reportIdentity.reportId, storedVersion, inputs.companyId, state, why);
        setPublicationRow(row);
        void transport.listSavedVersions(inputs.companyId, inputs.periodYear).then(setVersions, () => undefined);
        return { ok: true, message: `Recorded as ${state}.` };
      } catch (e) {
        const message = e instanceof FsTransportError ? e.message : e instanceof Error ? e.message : String(e);
        return { ok: false, message };
      }
    },
    [viewing, viewerReadOnly, transport, snapshot, storedVersion, saveStatus, inputs.companyId, inputs.periodYear],
  );

  // ── reopening saved work ────────────────────────────────────────────────
  const shellReportId = useMemo(() => evidenceOnlyShellFor([])?.reportIdentity.reportId ?? null, [evidenceOnlyShellFor]);
  const workingReportId = baseSnapshot?.report.reportIdentity.reportId ?? (profile?.trialBalance.status === "UNSUPPORTED" ? shellReportId : null);

  // Reload recovery: a fresh session re-reads the server's LATEST saved version and rebuilds an editable draft from it.
  // The rebuild is accepted only if it reproduces the stored version exactly; otherwise the draft stays fresh and says why.
  useEffect(() => {
    if (!transport || !access?.enabled || status !== "ready" || !profile || !workingReportId) return;
    const evidenceOnly = profile.trialBalance.status === "UNSUPPORTED";
    if (!evidenceOnly && !baseSnapshot) return;
    const key = [inputs.companyId, inputs.periodYear, signatureRef.current ?? "evidence-only", generation, restoreNonce].join("|");
    if (restoredKeyRef.current === key) return;
    restoredKeyRef.current = key;
    let cancelled = false;
    setRestore({ status: "LOADING", message: null });
    void (async () => {
      try {
        const list = await transport.listSavedVersions(inputs.companyId, inputs.periodYear);
        if (cancelled) return;
        setVersions(list);
        const latest = list.find((v) => v.reportId === workingReportId && v.isLatest);
        if (!latest) {
          setRestore({ status: "NOTHING_SAVED", message: null });
          return;
        }
        const [stored, decisions, evidenceRows, pubs] = await Promise.all([
          transport.readReportVersion(inputs.companyId, workingReportId, latest.reportVersion),
          transport.listDecisions(workingReportId),
          Promise.all([`FY${inputs.periodYear}`, `FY${inputs.periodYear - 1}`].map((p) => transport.listEvidence(inputs.companyId, p))).then((a) => a.flat()),
          transport.listPublications(workingReportId),
        ]);
        if (cancelled) return;
        if (!stored) {
          setRestore({ status: "ERROR", message: `Saved version ${latest.reportVersion} could not be read.` });
          return;
        }
        const outcome = restoreLatestDraft({
          companyId: inputs.companyId,
          freshBase: baseSnapshot?.report ?? null,
          stored,
          decisions,
          evidenceRows,
          compose: (base, ev) => (base ? applyEvidence({ report: base, profile, evidence: ev, cashAccountKeys: mappingInfo?.cashAccountKeys ?? [], mappingCoverage }).report : (() => { const shell = evidenceOnlyShellFor(ev); return shell ? applyEvidence({ report: shell, profile, evidence: ev }).report : null; })()),
        });
        if (outcome.kind === "DIVERGED") {
          setRestore({ status: "DIVERGED", message: `Saved version ${outcome.storedVersion} could not be restored for editing: ${outcome.reason} Open it under Saved versions to read it exactly as stored; saving now creates a new version.` });
          return;
        }
        const s = outcome.session;
        if (s.baseReport) {
          const snap = { report: s.baseReport, decisions: s.baseDecisions };
          await repoRef.current.saveReport(snap);
          if (cancelled) return;
          setBaseSnapshot(snap);
        } else {
          await repoRef.current.saveReport({ report: s.effectiveReport, decisions: s.baseDecisions });
          if (cancelled) return;
          setDecisionRevision((n) => n + 1);
        }
        savedRef.current = s.saved;
        setEvidenceStore(s.evidence);
        setEvidenceCorrections(s.evidenceCorrections);
        setStoredVersion(s.storedVersion);
        setPublicationRow([...pubs].filter((p) => p.reportVersion === s.storedVersion).sort((a, b) => b.seq - a.seq)[0] ?? null);
        markSavedRef.current = !s.unsavedChanges;
        setRestore({ status: "RESTORED", message: s.unsavedChanges ? `Restored your saved work (version ${s.storedVersion}) plus evidence stored after it — save to include that evidence in a new version.` : `Restored your saved work (version ${s.storedVersion}).` });
      } catch (e) {
        if (cancelled) return;
        restoredKeyRef.current = null;
        setRestore({ status: "ERROR", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, access, status, profile, baseSnapshot, workingReportId, inputs.companyId, inputs.periodYear, generation, restoreNonce]);

  const reloadFromServer = useCallback(() => {
    repoRef.current = new InMemoryFinancialStatementReportRepository();
    savedRef.current = null;
    savedKeyRef.current = null;
    markSavedRef.current = false;
    restoredKeyRef.current = null;
    signatureRef.current = null;
    setViewing(null);
    setEvidenceStore([]);
    setEvidenceCorrections([]);
    setStoredVersion(null);
    setPublicationRow(null);
    setNotice(null);
    setSaveMessage(null);
    setSaveStatus("CLEAN");
    setRestoreNonce((n) => n + 1);
    setGeneration((g) => g + 1);
  }, []);

  const openVersion = useCallback(
    async (reportVersion: number) => {
      if (!transport || !workingReportId) return { ok: false, message: "Saved versions are not available." };
      const summary = versions.find((v) => v.reportId === workingReportId && v.reportVersion === reportVersion);
      if (!summary) return { ok: false, message: `Version ${reportVersion} is not in the list of saved versions for this company and year.` };
      try {
        const [stored, evaluations, decisions, evidenceRows, publications] = await Promise.all([
          transport.readReportVersion(inputs.companyId, workingReportId, reportVersion),
          transport.listEvaluations(workingReportId, reportVersion),
          transport.listDecisions(workingReportId),
          Promise.all([`FY${inputs.periodYear}`, `FY${inputs.periodYear - 1}`].map((p) => transport.listEvidence(inputs.companyId, p))).then((a) => a.flat()),
          transport.listPublications(workingReportId),
        ]);
        if (!stored) return { ok: false, message: `Version ${reportVersion} could not be read.` };
        const view = historicalView({ companyId: inputs.companyId, version: stored, isLatest: summary.isLatest, state: summary.state, evaluations, decisions, evidenceRows, publications });
        if (!view) return { ok: false, message: "That version does not belong to this company." };
        setViewing(view);
        return { ok: true, message: `Showing saved version ${reportVersion} exactly as stored (read-only).` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    [transport, workingReportId, versions, inputs.companyId, inputs.periodYear],
  );
  const closeVersion = useCallback(() => setViewing(null), []);

  // The server's readiness preview for the stored latest version (the client may preview; the database decides).
  useEffect(() => {
    if (!transport || storedVersion === null || saveStatus !== "SAVED" || !workingReportId) {
      setReadiness(null);
      return;
    }
    let cancelled = false;
    void transport.reportReadiness(inputs.companyId, workingReportId, storedVersion).then(
      (r) => !cancelled && setReadiness(r),
      () => !cancelled && setReadiness(null),
    );
    return () => {
      cancelled = true;
    };
  }, [transport, storedVersion, saveStatus, workingReportId, inputs.companyId, publication]);

  // What the surfaces render: the stored version exactly as recorded while viewing, otherwise the live working draft.
  const historical = useMemo(() => {
    if (!viewing) return null;
    const run: EvaluationRunRecord | null = viewing.evaluation
      ? { evaluationRunId: viewing.evaluation.evaluationRunId, reportId: viewing.reportId, reportVersion: viewing.reportVersion, inputHash: viewing.evaluation.inputHash, rulePack: { rulePackId: viewing.evaluation.rulePackId, rulePackVersion: viewing.evaluation.rulePackVersion }, engineVersion: viewing.evaluation.engineVersion, findings: viewing.findings, createdAt: viewing.evaluation.createdAt }
      : null;
    return {
      snapshot: { report: viewing.report, decisions: viewing.decisions } as StoredReportSnapshot,
      evaluation: run,
      numbering: deriveNoteNumbering(viewing.report),
      views: buildFindingViews(viewing.findings, viewing.decisions),
      evidence: viewing.evidence.map((batch): EvidenceEntry => ({ batch, version: viewing.evidenceVersions[batch.evidenceBatchId] ?? 1, saved: true, used: true, useReason: `Used by saved version ${viewing.reportVersion}.` })),
    };
  }, [viewing]);

  // ── composition / sources / structure ───────────────────────────────────
  const composition = useMemo(
    () =>
      profile
        ? composeStatements({
            profile,
            report: snapshot?.report ?? null,
            comparativeAvailable: comparative.state === "AVAILABLE" && (!snapshot || snapshot.report.comparativePeriods.length > 0),
            cashPerimeterReviewed: mappingInfo?.cashReviewed ?? false,
            generated: applied ? Object.fromEntries(applied.generated.map((g) => [g.kind, g.result])) : undefined,
            budgetActual: applied?.budgetActual ?? null,
          })
        : null,
    [profile, snapshot, comparative, mappingInfo, applied],
  );

  const sources = useMemo(
    () =>
      buildSources({
        currentUpload: inputs.currentUpload ? { id: inputs.currentUpload.id, file_name: inputs.currentUpload.file_name, status: inputs.currentUpload.status, is_valid: inputs.currentUpload.is_valid } : null,
        periodYear: inputs.periodYear,
        comparative,
        documentReviewEnabled: DOCUMENT_REVIEW_ENABLED,
        evidence: latestEvidence.map((b) => ({ evidenceType: b.evidenceType, periodRole: b.periodRole, validationStatus: b.validationStatus, evidenceBatchId: b.evidenceBatchId })),
      }),
    [inputs.currentUpload, inputs.periodYear, comparative, latestEvidence],
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

  // ── persisted version authority: one report, one evaluation, one lineage for print and every export ──
  const persistedVersion: number | null = viewing ? viewing.reportVersion : saveStatus === "SAVED" && storedVersion !== null ? storedVersion : null;
  const publicationState = viewing ? viewing.state : (publication?.state ?? null);
  const sourceReport = viewing ? viewing.report : (snapshot?.report ?? null);
  const historicalEvaluation = historical?.evaluation ?? null;
  const output = useMemo(() => {
    if (!sourceReport) return null;
    const report = viewing ? sourceReport : outputReportFor(sourceReport, persistedVersion);
    // A persisted view uses the evaluation RECORDED for that version; current work is evaluated at exactly the version it is exported as.
    // Unsaved work is evaluated as the (valid) session document it is; its lineage says persisted: false.
    const evaluationRecord = viewing ? historicalEvaluation : evaluateReportPure(persistedVersion === null ? sourceReport : report, ZERO_TOLERANCE, STORED_FINDING_TIMESTAMP);
    return { report, evaluation: evaluationRecord, lineage: buildLineage({ report, persistedVersion, evaluation: evaluationRecord, publicationState }) };
  }, [sourceReport, viewing, persistedVersion, historicalEvaluation, publicationState]);

  const viewingComposition = useMemo(
    () =>
      viewing && profile
        ? composeStatements({ profile, report: viewing.report, comparativeAvailable: viewing.report.comparativePeriods.length > 0, cashPerimeterReviewed: true, generated: generatedFromStoredReport(viewing.report), budgetActual: budgetFromReport(viewing.report) })
        : null,
    [viewing, profile],
  );

  return {
    status, reason, diagnostics, profile, sources, structure,
    composition: viewing ? viewingComposition : composition,
    snapshot: historical ? historical.snapshot : modelSnapshot,
    evaluation: historical ? historical.evaluation : evaluation,
    numbering: historical ? historical.numbering : numbering,
    views: historical ? historical.views : views,
    persistence, notice, decide, rerun,
    evidence: historical ? historical.evidence : evidence,
    applied, checklist: viewing ? checklistFromReport(viewing.report, profile?.disclosureAreas ?? []) : (applied?.checklist ?? []), evidenceIndex: viewing ? {} : (applied?.evidenceIndex ?? {}), cashPerimeter: viewing ? null : (applied?.cashPerimeter ?? null), budgetComparison: viewing ? budgetFromReport(viewing.report) : (applied?.budgetActual ?? null), addEvidence, removeUnsavedEvidence, correctEvidence,
    saveStatus, saveMessage, access, storedVersion, save, publication, setPublication,
    persistedVersion, versionLabel: versionLabelOf(persistedVersion), output,
    restore, versions, viewing, readOnly: viewing !== null || viewerReadOnly, readOnlyAccess: viewerReadOnly, openVersion, closeVersion, reloadFromServer, readiness,
  };
}
