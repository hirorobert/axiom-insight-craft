/**
 * Prepare Data — the trial balance, stated once.
 *
 *   Current Trial Balance card   file, result, totals, one plain reason, one failure-appropriate action; Replace / Remove
 *   Trial balance checks          the four checks that decide acceptance (+ informational items apart)
 *   Account review                only when classifications need a decision
 *   Evidence verification         only once the trial balance is accepted; mandatory before tax
 *   Technical processing details  engine telemetry for auditors, collapsed
 *   Upload history                read-only, lifecycle-labelled, collapsed
 *
 * Everything that states the result reads one model: trialBalanceVerdict.ts (the certification ledger).
 */

import { useEffect, useRef, useState } from "react";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { buildPrepareUploadRoute, buildPrepareReviewRoute, canReprocessUpload } from "@/lib/workspace/resolveActiveUpload";
import { toast } from "sonner";

import { BalanceSheetEquationCard } from "@/components/certification/BalanceSheetEquationCard";
import { ClassificationBreakdown } from "@/components/certification/ClassificationBreakdown";
import { ValidationReport } from "@/components/ValidationReport";
import { AccountReviewPanel } from "@/components/AccountReviewPanel";
import {
  applyDiscardSuppression,
  suppressUpload,
  restoreUploadId,
} from "@/lib/workspace/discardSuppression";
import { TrialBalanceUpload } from "@/components/TrialBalanceUpload";
import { useEngagement } from "@/contexts/EngagementContext";
import { CurrentTrialBalanceCard } from "@/components/workspace/CurrentTrialBalanceCard";
import { TrialBalanceChecks } from "@/components/workspace/TrialBalanceChecks";
import { UploadHistory } from "@/components/workspace/UploadHistory";
import { deriveTrialBalanceVerdict, uploadSubjectKey } from "@/lib/workspace/trialBalanceVerdict";
import { EntityContextSuggestion } from "@/components/workspace/EntityContextSuggestion";
import { useCertificationReadiness } from "@/hooks/useCertificationReadiness";
import { computeCertificationReadiness } from "@/lib/workspace/computeCertificationReadiness";
import {
  reduceCertificationRevalidationGuard,
  canInitiateCertificationAffectingMutation,
} from "@/lib/workspace/certificationRevalidationGuard";
import TrialBalanceProgressLedger from "@/components/workspace/TrialBalanceProgressLedger";
import TrialBalanceTemplateGuide from "@/components/workspace/TrialBalanceTemplateGuide";
import {
  DiscardError,
  cancelReplacement,
  discardUpload,
  retireUpload,
  offerUndo,
} from "@/components/workspace/DiscardUploadDialog";
import { ManageTrialBalance } from "@/components/workspace/ManageTrialBalance";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import {
  MANAGE_TRIAL_BALANCE_PARAM,
  RemoveTrialBalanceError,
  decideRemoveAction,
  decideSourceManagementMode,
  fetchRemovalEligibility,
  removeTrialBalance,
  validateReplacementFile,
  type RemovalEligibility,
} from "@/lib/workspace/trialBalanceManagement";
import SafishaGate from "@/components/safisha/SafishaGate";
import { Button } from "@/components/ui/button";
import {
  SurfaceCard,
  SurfaceCardHeader,
  SurfaceCardBody,
} from "@/components/workspace/ui/Surface";
import { ChevronDown } from "lucide-react";
import { AccountMappingModal } from "@/components/AccountMappingModal";
import type { WorkspaceUpload } from "@/hooks/useWorkspaceData";
import { isPrepareOnly } from "@/lib/workspace/workspaceAccess";

// ── deriveFiscalPeriod (local copy — same logic as Dashboard) ────────────────
function deriveFiscalPeriod(
  upload: WorkspaceUpload,
  fiscalYearEnd: string | null,
): { periodYear: number; periodEndMonth: number } {
  if (upload.period_year && upload.period_year > 2000) {
    const fyeStr = upload.fiscal_year_end ?? fiscalYearEnd;
    const month = fyeStr ? new Date(fyeStr).getMonth() + 1 : 12;
    return { periodYear: upload.period_year, periodEndMonth: isNaN(month) ? 12 : month };
  }
  if (upload.fiscal_year_end) {
    const d = new Date(upload.fiscal_year_end);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  if (fiscalYearEnd) {
    const d = new Date(fiscalYearEnd);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  const uploadDate = new Date(upload.uploaded_at);
  const uploadMonth = uploadDate.getMonth() + 1;
  const uploadYear = uploadDate.getFullYear();
  return { periodYear: uploadMonth <= 9 ? uploadYear - 1 : uploadYear, periodEndMonth: 12 };
}

export default function PrepareWorkspace() {
  const { upload: rawUpload, uploads: rawUploads, company, companyId, periodYear, refreshUpload, access } = useWorkspace();
  // Prepare-only access (an explicit capability grant, PR #32): upload, replace, validate, discard and Undo. Account
  // review, mapping, the framework prompt and evidence reconciliation belong to other authorities and are not shown.
  const prepareOnly = isPrepareOnly(access);
  const { engagement } = useEngagement();
  // Discarded runs must vanish immediately — no residue while the refetch lands.
  const [discardedIds, setDiscardedIds] = useState<string[]>([]);
  const {
    upload,
    uploads,
    reviewAccounts: suppressedReviewAccounts,
  } = applyDiscardSuppression({
    upload: rawUpload,
    uploads: rawUploads,
    suppressed: discardedIds,
  });
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Deep link from the Overview exception count: land directly on the
  // unresolved accounts, no second hunt.
  const focusUnresolved = searchParams.get("review") === "unresolved";
  const reviewRef = useRef<HTMLDivElement>(null);
  const [processingOpen, setProcessingOpen] = useState(false);
  const [mappingModalOpen, setMappingModalOpen] = useState(false);
  const [showUploader, setShowUploader] = useState(false);
  const [retryingProcess, setRetryingProcess] = useState(false);
  // One-tap replace: the file the user picked to take over from the prior run.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [replacing, setReplacing] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // "Manage Trial Balance": what may be offered comes from the server (access + current plan + removal eligibility).
  const { state: capabilityState } = useWorkspaceCapabilities(companyId);
  const sourceMode = decideSourceManagementMode(access, capabilityState);
  const focusManage = searchParams.get(MANAGE_TRIAL_BALANCE_PARAM) === "source";
  const [removing, setRemoving] = useState(false);
  const [eligibility, setEligibility] = useState<{ key: string; value: RemovalEligibility } | null>(null);
  const eligibilityKey = upload ? `${upload.id}:${upload.version ?? ""}:${upload.lifecycle_state ?? ""}` : null;
  useEffect(() => {
    if (!upload || !eligibilityKey || sourceMode !== "manage") return;
    let cancelled = false;
    void fetchRemovalEligibility(upload.id)
      .catch((): RemovalEligibility => ({ status: "unavailable" }))
      .then((value) => { if (!cancelled) setEligibility({ key: eligibilityKey, value }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibilityKey, sourceMode]);
  const currentEligibility = eligibility && eligibility.key === eligibilityKey ? eligibility.value : null;
  const removeAction = sourceMode === "manage" ? decideRemoveAction(upload, currentEligibility) : null;

  // The replacement created by retireUpload() is processed exactly like a fresh upload. Evidence verification (the
  // non-skippable SafishaGate) is offered by the page itself once the verdict says the trial balance is accepted —
  // never on a trial balance that failed its own checks. It stays mandatory: tax is locked until evidence is clean.

  const processReplacement = async (uploadId: string, fileName: string) => {
    try {
      await ensureFreshSession();
      const { error } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId, clientRequestId: crypto.randomUUID() },
      });
      if (error) throw error;
      toast.success(`Processing ${fileName}. The result appears on this page.`);
    } catch (err) {
      console.error("[processReplacement]", err);
      // A 403 means the caller lacks validation authority (owner or explicit grant); a retry cannot succeed.
      const status = (err as { context?: { status?: number } })?.context?.status;
      if (status === 403) {
        toast.error(`${fileName} was saved as the replacement, but you don't have permission to validate trial balances in this workspace.`);
      } else {
        toast.error(`${fileName} was saved as the replacement, but processing did not start.`, {
          action: { label: "Retry processing", onClick: () => void processReplacement(uploadId, fileName) },
        });
      }
    } finally {
      refreshUpload();
    }
  };

  const retireAndProcess = async (current: WorkspaceUpload, file: File) => {
    const { newUploadId } = await retireUpload(current, file, "Replaced via Prepare Data");
    toast.success(`${current.file_name} retired — evidence preserved. Processing ${file.name}…`);
    setPendingFile(null);
    navigate(buildPrepareUploadRoute(companyId, periodYear), { replace: true });
    refreshUpload();
    await processReplacement(newUploadId, file.name);
  };

  /**
   * Replace Trial Balance: pick a file. The file is checked first, then uploaded, and only then does
   * retire_trial_balance_upload() swap it in, atomically, in one transaction: the prior upload becomes
   * 'superseded' (its row, certifications and results preserved, never deleted) and the new one is the period's
   * single active upload. If the check, the upload or the swap fails, nothing changed and the current Trial Balance
   * stays active. An unprocessed replacement can still be cancelled afterwards, which restores the prior one.
   */
  const handleReplacePicked = async (file: File | undefined) => {
    if (!file || !upload) return;
    const invalid = validateReplacementFile(file);
    if (invalid) {
      toast.error(`${invalid} The current Trial Balance was not changed.`);
      return;
    }
    setPendingFile(file);
    setReplacing(true);
    try {
      await retireAndProcess(upload, file);
    } catch (err) {
      setPendingFile(null);
      toast.error(
        err instanceof DiscardError
          ? `${err.safeMessage} The current Trial Balance is still active.`
          : "Could not replace the Trial Balance. The current Trial Balance is still active.",
      );
    } finally {
      setReplacing(false);
    }
  };

  /** After a removal: the removed upload leaves the screen at once and the page shows "Upload Trial Balance". */
  const showEmptySourceState = (removedId: string) => {
    setDiscardedIds((prev) => suppressUpload(prev, removedId));
    navigate(buildPrepareUploadRoute(companyId, periodYear), { replace: true });
    setShowUploader(true);
    refreshUpload();
  };

  /**
   * Remove Trial Balance (confirmed in ManageTrialBalance). The server's eligibility answer picked the path:
   * a processed, blocked or failed upload is retired (no Undo: retirement is terminal); an unprocessed one is
   * discarded through the PR #32 saga (Undo offered); an unprocessed replacement is cancelled (the prior returns).
   * Nothing with accounting evidence is ever deleted.
   */
  const handleRemove = async () => {
    if (!upload || !removeAction || removeAction.kind === "unavailable") return;
    const target = upload;
    setRemoving(true);
    try {
      if (removeAction.kind === "remove") {
        await removeTrialBalance(target);
        toast.success(`${target.file_name} removed from active use. Its audit history and evidence are preserved.`);
        showEmptySourceState(target.id);
      } else if (removeAction.kind === "discard") {
        const receipt = await discardUpload(target);
        showEmptySourceState(receipt.id);
        offerUndo(receipt, () => {
          setDiscardedIds((prev) => restoreUploadId(prev, receipt.id));
          setShowUploader(false);
          navigate(buildPrepareUploadRoute(companyId, periodYear, receipt.id), { replace: true });
          refreshUpload();
        });
      } else {
        const { storageCleanupPending } = await cancelReplacement(target);
        setDiscardedIds((prev) => suppressUpload(prev, target.id));
        toast.success(
          storageCleanupPending
            ? "Replacement cancelled. The earlier Trial Balance is active again; file clean-up will finish shortly."
            : "Replacement cancelled. The earlier Trial Balance is active again.",
        );
        navigate(buildPrepareUploadRoute(companyId, periodYear), { replace: true });
        refreshUpload();
      }
    } catch (err) {
      toast.error(
        err instanceof RemoveTrialBalanceError || err instanceof DiscardError
          ? (err instanceof DiscardError ? err.safeMessage : err.message)
          : "Could not remove this Trial Balance. Nothing was changed. Please try again.",
      );
      refreshUpload();
    } finally {
      setRemoving(false);
    }
  };

  const certReadiness = useCertificationReadiness(companyId, periodYear, upload?.id, uploadSubjectKey(upload));

  // PPG-1R HIGH-1 (Codex REJECT — "old CERTIFIED may remain visible while
  // reprocessing is already underway"): PPG-1's fix only invalidated
  // certification at the terminal/timeout boundary of a reprocess poll,
  // leaving the ENTIRE window between "backend accepted the reprocess"
  // and "poll detects a terminal status" (up to 90s) showing whatever
  // verdict was already on screen — including a real but now-superseded
  // CERTIFIED. This explicit guard closes that window: it is set the
  // INSTANT a reprocess is confirmed accepted (never merely "requested" —
  // an initiation failure never sets it) and stays true across the entire
  // poll, INCLUDING across the immediate refetch this triggers (which may
  // race ahead of the backend and return the very same stale certified
  // row — computeCertificationReadiness's `revalidating` guard downgrades
  // that to "pending" regardless of what the fetch returned, so the local
  // guard's truth wins over a stale server read, never the other way
  // around). It only clears once a fresh read has been taken AFTER a
  // confirmed terminal state, or is abandoned (left true, never
  // reverted to trusting a stale read) on timeout — per the mission's
  // explicit "remain non-authoritative/pending rather than restoring
  // stale CERTIFIED."
  const [isRevalidatingCertification, setIsRevalidatingCertification] = useState(false);
  const activeReprocessPollRef = useRef<{ interval: number; timeout: number } | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (activeReprocessPollRef.current) {
        window.clearInterval(activeReprocessPollRef.current.interval);
        window.clearTimeout(activeReprocessPollRef.current.timeout);
      }
    };
  }, []);

  const clearActiveReprocessPoll = () => {
    if (activeReprocessPollRef.current) {
      window.clearInterval(activeReprocessPollRef.current.interval);
      window.clearTimeout(activeReprocessPollRef.current.timeout);
      activeReprocessPollRef.current = null;
    }
  };

  const handleProcessAsAuditedAccounts = async () => {
    // Only an active upload is ever reprocessed (PR #32 N-04); the server refuses the rest (409) regardless.
    if (!upload || !canReprocessUpload(upload)) return;
    // Rapid second invocation: a reprocess is already in flight (from this
    // control or from AccountReviewPanel's own Save/Reprocess) — refuse a
    // second concurrent one rather than racing two polls against the same
    // upload.
    if (!canInitiateCertificationAffectingMutation(isRevalidatingCertification)) return;
    toast.info("Re-processing as Audited Financial Statements…");
    try {
      await ensureFreshSession();
      const clientRequestId = crypto.randomUUID();
      const { error } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId: upload.id, mode: "audited_accounts", clientRequestId },
      });
      // Initiation failure: nothing was actually accepted — the guard is
      // never entered, and whatever certification state was already
      // showing (still genuinely current, since nothing changed) is left
      // exactly as it was. Only the mutation-failure toast is shown.
      if (error) {
        setIsRevalidatingCertification((prev) =>
          reduceCertificationRevalidationGuard(prev, { type: "MUTATION_INITIATION_FAILED" }),
        );
        throw error;
      }
      toast.success("Processing started — results will appear shortly.");

      // Reprocess CONFIRMED ACCEPTED — invalidate immediately, before any
      // terminal check. The refetch triggered here may well race ahead of
      // the backend and return the pre-mutation CERTIFIED row; that is
      // expected and safe, because the guard (not the fetch result) is
      // what computeCertificationReadiness keys its "pending" downgrade
      // on — see the guard's own comment above.
      if (!isMountedRef.current) return;
      setIsRevalidatingCertification((prev) =>
        reduceCertificationRevalidationGuard(prev, { type: "MUTATION_ACCEPTED" }),
      );
      certReadiness.refetch();

      const uploadId = upload.id;
      const TERMINAL = new Set(["complete", "error", "blocked", "needs_review"]);
      let settled = false;
      const pollInterval = window.setInterval(async () => {
        const { data } = await supabase
          .from("trial_balance_uploads")
          .select("status")
          .eq("id", uploadId)
          .single();

        if (settled || !data || !TERMINAL.has(data.status)) return;
        settled = true;
        clearActiveReprocessPoll();
        await refreshUpload();
        certReadiness.refetch();
        // A genuinely fresh, terminal-boundary read has now landed — safe
        // to let computeCertificationReadiness trust it again.
        if (isMountedRef.current) {
          setIsRevalidatingCertification((prev) =>
            reduceCertificationRevalidationGuard(prev, { type: "TERMINAL_CONFIRMED" }),
          );
        }
        if (data.status === "complete") {
          toast.success("Reprocessing complete!");
        } else if (data.status === "needs_review") {
          toast.warning("Some accounts still need review.");
        } else {
          toast.error("Reprocessing encountered an error.");
        }
      }, 2000);

      const pollTimeout = window.setTimeout(async () => {
        if (settled) return;
        settled = true;
        clearActiveReprocessPoll();
        await refreshUpload();
        certReadiness.refetch();
        // Timeout: we could NOT confirm a terminal state. Per the mission's
        // explicit contract, remain non-authoritative/pending rather than
        // trusting whatever this last read returned (it may still be the
        // pre-mutation CERTIFIED if the backend is simply slow, not done).
        // reduceCertificationRevalidationGuard's TIMEOUT_NO_TERMINAL_CONFIRMED
        // branch intentionally keeps the guard true — the upload-status-
        // transition effect below will still clear it later if/when the
        // backend eventually does reach a terminal state via realtime.
        if (isMountedRef.current) {
          setIsRevalidatingCertification((prev) =>
            reduceCertificationRevalidationGuard(prev, { type: "TIMEOUT_NO_TERMINAL_CONFIRMED" }),
          );
        }
      }, 90_000);

      activeReprocessPollRef.current = { interval: pollInterval, timeout: pollTimeout };
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start processing. Please try again.");
    }
  };

  const readinessInput = upload
    ? {
        uploadExists: true,
        currentUploadId: upload.id,
        authoritative: certReadiness.authoritative,
        latestForUpload: certReadiness.latestForUpload,
        fetchFailed: certReadiness.fetchFailed,
        revalidating: isRevalidatingCertification || certReadiness.loading,
      }
    : null;
  const readiness = readinessInput ? computeCertificationReadiness(readinessInput) : undefined;
  // Presentation only: the row those readiness layers were drawn from, so the card can draw informational layers
  // neutrally from their structured severity (certificationCheckPresentation.ts).
  const verdict = deriveTrialBalanceVerdict({ upload: upload ?? null, readiness, readinessSubject: certReadiness.subjectKey, canRetry: canReprocessUpload(upload) });

  // Re-run processing after an engine failure (never offered for a blocked trial balance: its checks ran and the same
  // file would fail again). Only the Edge Function writes; the page makes no financial write.
  const handleRetry = async () => {
    if (!upload?.id || retryingProcess || !canReprocessUpload(upload)) return;
    setRetryingProcess(true);
    try {
      await ensureFreshSession();
      const { error } = await supabase.functions.invoke("process-trial-balance", { body: { uploadId: upload.id, clientRequestId: crypto.randomUUID() } });
      if (error) throw error;
      toast.success("Processing started. The result appears on this page.");
    } catch (err) {
      console.error("[handleRetry]", err);
      toast.error("Processing did not start. Please try again.");
    } finally {
      setRetryingProcess(false);
      refreshUpload();
      certReadiness.refetch();
    }
  };

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const onPrimary = (kind: NonNullable<typeof verdict.primaryAction>["kind"]) => {
    if (kind === "replace") replaceInputRef.current?.click();
    else if (kind === "retry") void handleRetry();
    else if (kind === "review_classifications") {
      if (reviewRef.current) reviewRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      else navigate(buildPrepareReviewRoute(companyId, periodYear, upload?.id ?? null));
    }
    else if (kind === "verify_evidence") scrollTo("evidence-verification");
    else if (kind === "continue") navigate(`/workspace/${companyId}/${periodYear}/reconcile`);
  };

  // PPG-1 Finding 1 (defense in depth for the upload/replace path):
  // useWorkspaceData already holds a realtime `postgres_changes` UPDATE
  // subscription on trial_balance_uploads (proven, existing pattern), so
  // `upload.status` here updates live as the server-side engine run
  // progresses even without any refetch call. The one thing nothing
  // already does is tell the certification hook to revalidate when that
  // happens — this effect closes that gap generically for ANY path that
  // takes this upload from a non-terminal to a terminal status (upload/
  // replace being the one with no other explicit refetch trigger), without
  // duplicating per-caller polling logic.
  const uploadStatusTrackRef = useRef<{ id: string | null; status: string | null }>({
    id: null,
    status: null,
  });
  useEffect(() => {
    const TERMINAL = new Set(["complete", "error", "blocked", "needs_review"]);
    const prev = uploadStatusTrackRef.current;
    const currentId = upload?.id ?? null;
    const currentStatus = upload?.status ?? null;
    if (prev.id !== currentId) {
      // A different upload is now on screen (replace, discard+undo,
      // history-panel selection) — any revalidation guard was scoped to
      // the PREVIOUS upload's lifecycle and no longer applies. The new
      // upload gets its own fresh certification read (and its own
      // `certReadiness.loading`-driven "pending" state while that read is
      // in flight) from useCertificationReadiness's own identity-keyed
      // effect — never carry a stuck guard across uploads.
      clearActiveReprocessPoll();
      setIsRevalidatingCertification((prev) =>
        reduceCertificationRevalidationGuard(prev, { type: "UPLOAD_IDENTITY_CHANGED" }),
      );
    }
    if (
      prev.id === currentId &&
      prev.status !== currentStatus &&
      !!currentStatus && TERMINAL.has(currentStatus) &&
      !!prev.status && !TERMINAL.has(prev.status)
    ) {
      certReadiness.refetch();
      // PPG-1R: a genuine terminal transition landed via realtime — this
      // is a real freshness boundary regardless of which caller triggered
      // the underlying reprocess, so the revalidation guard clears here
      // too. Belt-and-suspenders alongside each caller's own explicit
      // clear (handleProcessAsAuditedAccounts's poll,
      // AccountReviewPanel's onReprocessed) — covers any path that
      // changes upload.status without going through either of them.
      setIsRevalidatingCertification((prev) =>
        reduceCertificationRevalidationGuard(prev, { type: "TERMINAL_CONFIRMED" }),
      );
    }
    uploadStatusTrackRef.current = { id: currentId, status: currentStatus };
    // certReadiness.refetch is a stable useCallback identity (empty deps in
    // useCertificationReadiness.ts) — only upload?.id/upload?.status
    // transitions should re-run this effect, not every render's fresh
    // certReadiness object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upload?.id, upload?.status, certReadiness.refetch]);

  const mapping = upload?.processing_result?.mapping;

  const reviewAccounts = suppressedReviewAccounts as any[];
  const showReviewPanel =
    upload?.status === "needs_review" &&
    // Review ends in a reprocess; a historical upload (pinned via ?upload=) is never reprocessed (PR #32 F-01).
    canReprocessUpload(upload) &&
    reviewAccounts.length > 0 &&
    !!upload?.company_id &&
    !!user;
  useEffect(() => {
    if (!focusUnresolved || !showReviewPanel) return;
    const t = window.setTimeout(() => {
      reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(t);
  }, [focusUnresolved, showReviewPanel]);

  return (
    <div className="mx-auto max-w-5xl space-y-5 pb-10">
      <header className="border-b border-border pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Prepare data · FY{periodYear}
            </p>
            <h1 className="mt-1 text-xl font-semibold text-foreground">Trial balance</h1>
            {!prepareOnly && <EntityContextSuggestion reportingFrameworkDbValue={company?.reporting_framework} companyCreatedAt={company?.created_at} />}
          </div>
        </div>
      </header>

      <div className="space-y-5">
          {/* The Current Trial Balance card: file, result, totals, one reason, one action. Replace / Remove live here. */}
          {upload && !showUploader && (
            <>
              <input
                ref={replaceInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  void handleReplacePicked(file);
                }}
              />
              <CurrentTrialBalanceCard
                fileName={upload.file_name}
                uploadedAt={upload.uploaded_at}
                fileSize={upload.file_size}
                verdict={verdict}
                busy={replacing || retryingProcess}
                onPrimary={onPrimary}
                management={
                  <ManageTrialBalance
                    variant="inline"
                    hideReplace={verdict.primaryAction?.kind === "replace" && sourceMode === "manage"}
                    mode={sourceMode}
                    removeAction={removeAction}
                    replacing={replacing}
                    removing={removing}
                    focusRequested={focusManage}
                    onReplace={() => replaceInputRef.current?.click()}
                    onRemove={handleRemove}
                  />
                }
              />
            </>
          )}

          {/* Upload surface — the one thing to do when nothing is here yet. */}
          {(!upload || showUploader) && (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
            <SurfaceCard>
              <SurfaceCardHeader
                label="Upload Trial Balance"
                action={
                  upload ? (
                    <Button variant="ghost" size="sm" onClick={() => setShowUploader(false)}>
                      Close
                    </Button>
                  ) : undefined
                }
              />
              <SurfaceCardBody>
                <TrialBalanceUpload
                  embedded
                  lockedCompanyId={companyId}
                  lockedCompanyName={company?.name ?? undefined}
                  periodYear={periodYear}
                  engagementId={engagement?.id ?? null}
                  periodId={engagement?.fiscal_period_id ?? null}
                  initialFile={pendingFile}
                  autoProcess={!!pendingFile}
                  evidenceByReconcileOnly={prepareOnly}
                  evidenceGateHandledByParent
                  onUploaded={() => {
                    setShowUploader(false);
                    setPendingFile(null);
                    // Drop any pinned ?upload=<id> so the newest upload shows.
                    navigate(buildPrepareUploadRoute(companyId, periodYear), { replace: true });
                    refreshUpload();
                  }}
                />
              </SurfaceCardBody>
            </SurfaceCard>
            <TrialBalanceTemplateGuide />
            </div>
          )}

          {upload ? (
            <>
              <TrialBalanceChecks verdict={verdict} />

              {/* Account review — only when classifier has unresolved accounts */}
              {prepareOnly && showReviewPanel && (
                <p data-testid="prepare-only-review-note" className="text-[13px] text-muted-foreground">
                  Some accounts need a classification decision. Account review requires separate access to this workspace.
                </p>
              )}
              {!prepareOnly && showReviewPanel && upload.company_id && user && (
                <div ref={reviewRef}>
                  <AccountReviewPanel
                    key={upload.id}
                    uploadId={upload.id}
                    companyId={upload.company_id}
                    userId={user.id}
                    needsReviewAccounts={reviewAccounts}
                    focusUnresolved={focusUnresolved}
                    onReprocessingStarted={() => {
                      // PPG-1R HIGH-1: the SAME immediate-invalidation
                      // contract as handleProcessAsAuditedAccounts — the
                      // moment reprocessing is confirmed accepted, not at
                      // its terminal/timeout boundary.
                      setIsRevalidatingCertification((prev) =>
                        reduceCertificationRevalidationGuard(prev, { type: "MUTATION_ACCEPTED" }),
                      );
                      certReadiness.refetch();
                    }}
                    onReprocessed={(reason) => {
                      // PPG-1 Finding 1: refreshUpload() alone re-reads the
                      // upload row, but the account-review decision +
                      // reprocess flow keeps the SAME upload id — the
                      // certification hook's effect only re-fires on an
                      // identity change, so without this explicit refetch
                      // the pre-flight panel would keep showing whatever
                      // certification state existed before the decisions
                      // were saved, until an unrelated navigation or a
                      // manual reload happened to remount it.
                      refreshUpload();
                      certReadiness.refetch();
                      // PPG-1R: "initiation_failed" — the guard was never
                      // set (onReprocessingStarted never ran), so clearing
                      // it is a no-op; this refetch simply confirms
                      // whatever is genuinely still current.
                      // "terminal" — a genuinely fresh, confirmed-terminal
                      // read has landed; safe to trust again.
                      // "timeout" — deliberately NOT cleared: no terminal
                      // state was ever confirmed, so the display must
                      // remain non-authoritative/pending rather than
                      // reverting to trust a possibly-stale read. The
                      // upload-status-transition effect will still clear
                      // it later if/when a terminal status eventually
                      // arrives via realtime.
                      if (reason === "terminal") {
                        setIsRevalidatingCertification((prev) =>
                          reduceCertificationRevalidationGuard(prev, { type: "TERMINAL_CONFIRMED" }),
                        );
                      } else if (reason === "initiation_failed") {
                        setIsRevalidatingCertification((prev) =>
                          reduceCertificationRevalidationGuard(prev, { type: "MUTATION_INITIATION_FAILED" }),
                        );
                      } else {
                        setIsRevalidatingCertification((prev) =>
                          reduceCertificationRevalidationGuard(prev, { type: "TIMEOUT_NO_TERMINAL_CONFIRMED" }),
                        );
                      }
                    }}
                  />
                </div>
              )}

              {verdict.evidenceUnlocked && !verdict.evidenceCleared && canReprocessUpload(upload) && (
                <section id="evidence-verification" aria-labelledby="evidence-verification-title" className="border border-border bg-card" data-testid="evidence-verification">
                  <div className="border-b border-border px-5 py-4 sm:px-7">
                    <h2 id="evidence-verification-title" className="text-[15px] font-semibold text-foreground">Evidence verification</h2>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      Required before the next stage: match the accepted trial balance to bank statements, mobile-money exports or subledgers.
                    </p>
                  </div>
                  {prepareOnly ? (
                    <p className="px-5 py-4 text-[13px] text-muted-foreground sm:px-7" data-testid="evidence-by-reconcile">
                      Evidence verification is completed by someone with Reconcile access. Later stages stay locked until it clears.
                    </p>
                  ) : (
                    <div className="px-5 py-4 sm:px-7">
                      <SafishaGate
                        uploadId={upload.id}
                        fileName={upload.file_name}
                        onCleared={() => {
                          toast.success("Evidence verified — the trial balance can move on.");
                          refreshUpload();
                        }}
                        onBlocked={() => {
                          toast.error("Evidence did not match. Review the exceptions, or replace the trial balance.");
                          refreshUpload();
                        }}
                      />
                    </div>
                  )}
                </section>
              )}

              {/* Engine telemetry for auditors, collapsed. The result itself is stated once, above. */}
              <SurfaceCard>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setProcessingOpen((v) => !v)}
                  aria-expanded={processingOpen}
                  className="h-auto w-full justify-between rounded-none px-5 py-3"
                >
                  <span className="text-[13px] font-semibold text-foreground">Technical processing details</span>
                  <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${processingOpen ? "rotate-180" : ""}`} />
                </Button>
                {processingOpen && (
                  <div className="space-y-4 border-t border-border p-4">
                    <div data-testid="certification-ledger" data-active-upload-id={upload.id}>
                      <TrialBalanceProgressLedger upload={upload} failedCheckId={verdict.failedCheckId} />
                    </div>
                    <BalanceSheetEquationCard upload={upload} />
                    <ClassificationBreakdown upload={upload} />
                    <ValidationReport
                      report={upload.validation_report}
                      errors={upload.accounting_errors || []}
                      isValid={upload.is_valid}
                      status={upload.status}
                      fileName={upload.file_name}
                      onProcessAsAuditedAccounts={canReprocessUpload(upload) ? handleProcessAsAuditedAccounts : undefined}
                      onUploadNew={() => navigate(`/workspace/${companyId}/${periodYear}/prepare`)}
                    />
                    {mapping && (
                      <Button variant="outline" size="sm" disabled={prepareOnly} onClick={() => setMappingModalOpen(true)}>
                        View mapped accounts
                      </Button>
                    )}
                  </div>
                )}
              </SurfaceCard>

              <UploadHistory
                uploads={rawUploads}
                currentId={rawUpload?.id ?? null}
                viewingId={upload.id}
                onOpen={(u) => {
                  const selected = u as WorkspaceUpload;
                  const { periodYear: newPY } = deriveFiscalPeriod(selected, company?.fiscal_year_end ?? null);
                  setShowUploader(false);
                  navigate(buildPrepareUploadRoute(companyId, newPY, selected.id));
                }}
              />
            </>
          ) : null}
      </div>

      {upload && (
        <AccountMappingModal
          uploadId={upload.id}
          open={mappingModalOpen}
          onOpenChange={setMappingModalOpen}
          mapping={(upload.processing_result as any)?.mapping ?? null}
        />
      )}

    </div>
  );
}
