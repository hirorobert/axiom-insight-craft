/**
 * TrialBalanceUpload — the workspace uploader for ONE trial balance (a period has one active trial balance).
 *
 * It renders lib/ingestion/uploadFlow exactly: one primary action per state, a compact card for the chosen file, the
 * real steps (upload → save to this period → check) marked done only when each call has returned, and a plain
 * sentence for every failure with the one retry that is safe. Retries reuse the identities already obtained (the
 * reservation, the upload, the check's request id), so trying again never registers or processes the file twice.
 *
 * Nothing here decides an accounting outcome: the server's check does. When it finishes, the page's trial-balance card
 * states the result, the checks and what to do next (onUploaded).
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { CheckCircle2, Circle, FileSpreadsheet, Loader2, Upload, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAuditLog } from "@/hooks/useAuditLog";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { registerWorkspaceUpload, uploadWorkspaceSource } from "@/lib/workspace/sourceUpload";
import {
  TWO_PERIOD_INTAKE_ENABLED, adjacentPriorPeriod, registerTwoPeriodUpload, type PeriodRow, type TwoPeriodRpcClient,
} from "@/lib/workspace/twoPeriodIntake";
import {
  ACCEPTED_EXTENSIONS, INITIAL_FLOW, POLL_DELAYS_MS, actionsFor, checkFinished, classifyCheckAnswer, classifySourceFailure,
  isBusy, reduceFlow, stepsFor, type FlowActionId, type FlowState, type StepStatus,
} from "@/lib/ingestion/uploadFlow";

export interface TrialBalanceUploadProps {
  /** Kept for the call site; the uploader is always the in-workspace panel. */
  embedded?: boolean;
  /** The workspace the trial balance belongs to. */
  lockedCompanyId?: string;
  lockedCompanyName?: string;
  /** Financial year the upload belongs to (written to period_year). */
  periodYear?: number;
  /** Engagement the upload belongs to (a DB trigger rejects a mismatched company or period). */
  engagementId?: string | null;
  /** Reporting period of record for the engagement (fiscal_periods.id). */
  periodId?: string | null;
  /** Seed with a file picked elsewhere (one-tap discard-and-reupload). */
  initialFile?: File | null;
  /** Start the seeded file immediately — no second click. */
  autoProcess?: boolean;
  /** Called once the check has finished, so the page can show the result. */
  onUploaded?: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readFunctionAnswer(error: unknown): Promise<{ httpStatus: number | null; body: Record<string, unknown> | null }> {
  const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown> } } | null)?.context;
  const httpStatus = typeof ctx?.status === "number" ? ctx.status : null;
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await ctx?.json?.();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { httpStatus, body };
}

const STEP_ICON: Record<StepStatus, JSX.Element> = {
  done: <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />,
  active: <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />,
  failed: <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />,
  pending: <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />,
};
const STEP_WORD: Record<StepStatus, string> = { done: "Done", active: "In progress", failed: "Stopped", pending: "Waiting" };

export const TrialBalanceUpload = ({
  lockedCompanyId,
  periodYear,
  engagementId = null,
  periodId = null,
  initialFile = null,
  autoProcess = false,
  onUploaded,
}: TrialBalanceUploadProps = {}) => {
  const [flow, dispatch] = useReducer(reduceFlow, INITIAL_FLOW);
  const flowRef = useRef<FlowState>(flow);
  flowRef.current = flow;
  const fileRef = useRef<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const { user } = useAuth();
  const { logAction } = useAuditLog();

  // ── One file, two years (I1-B; shown only when released and the period just before this one exists) ─────────────
  const [priorPeriod, setPriorPeriod] = useState<PeriodRow | null>(null);
  const [includePrior, setIncludePrior] = useState(false);
  const [priorNote, setPriorNote] = useState<string | null>(null);
  useEffect(() => {
    if (!TWO_PERIOD_INTAKE_ENABLED || !lockedCompanyId || !periodId) return;
    let live = true;
    void (supabase.from("fiscal_periods") as unknown as {
      select(c: string): { eq(c: "company_id", v: string): PromiseLike<{ data: PeriodRow[] | null }> };
    }).select("id, period_label, fiscal_year_end, reporting_start, reporting_end").eq("company_id", lockedCompanyId)
      .then(({ data }) => { if (live) setPriorPeriod(adjacentPriorPeriod(data ?? [], periodId)); });
    return () => { live = false; };
  }, [lockedCompanyId, periodId]);

  // ── Choosing a file ──────────────────────────────────────────────────────────────────────────────────────────────
  const choose = useCallback(async (file: File | undefined | null) => {
    if (!file || isBusy(flowRef.current)) return;
    fileRef.current = file;
    dispatch({ type: "SELECT", file: { name: file.name, size: file.size } });
    // A file with this name already checked for this workspace: say so before it is sent (the earlier one stays in history).
    if (!lockedCompanyId) return;
    const { data } = await supabase
      .from("trial_balance_uploads")
      .select("uploaded_at")
      .eq("company_id", lockedCompanyId)
      .eq("file_name", file.name)
      .in("status", ["complete", "valid"])
      .order("uploaded_at", { ascending: false })
      .limit(1);
    const previous = (data as { uploaded_at: string }[] | null)?.[0]?.uploaded_at ?? null;
    if (previous && fileRef.current === file) dispatch({ type: "SELECT", file: { name: file.name, size: file.size, previouslyCheckedAt: previous } });
  }, [lockedCompanyId]);

  // ── The steps ────────────────────────────────────────────────────────────────────────────────────────────────────
  const runCheck = useCallback(async (uploadId: string, clientRequestId: string) => {
    await ensureFreshSession();
    const { error } = await supabase.functions.invoke("process-trial-balance", { body: { uploadId, clientRequestId } });
    const answer = error ? await readFunctionAnswer(error) : { httpStatus: 200, body: null };
    let outcome = classifyCheckAnswer(answer);
    // Another request is already checking this upload: wait for its recorded outcome (bounded), never run it twice.
    if (outcome.kind === "wait") {
      outcome = { kind: "failed", failure: { step: "check", retry: "same_request", fileSaved: true, message: "The check is taking longer than expected. Check again in a moment — it will not be counted twice." } };
      for (const delay of POLL_DELAYS_MS) {
        await sleep(delay);
        const { data } = await supabase.from("trial_balance_uploads").select("status").eq("id", uploadId).maybeSingle();
        if (checkFinished((data as { status?: string } | null)?.status)) { outcome = { kind: "finished" }; break; }
      }
    }
    if (outcome.kind === "failed") {
      dispatch({ type: "FAILED", failure: outcome.failure });
      return;
    }
    dispatch({ type: "CHECKED" });
    logAction({ action: "process_trial_balance", entityType: "trial_balance_upload", entityId: uploadId, metadata: { fileName: fileRef.current?.name } });
    // The page states the result. Supporting-evidence reconciliation is not part of Trial balance review.
    onUploaded?.();
  }, [logAction, onUploaded]);

  const runRegister = useCallback(async (reservationId: string, clientRequestId: string) => {
    const file = fileRef.current;
    if (!file) return;
    try {
      let uploadId: string;
      if (includePrior && priorPeriod && periodId) {
        // Both years in one transaction or neither; a retry with the same request returns the same pair.
        const pair = await registerTwoPeriodUpload(supabase as unknown as TwoPeriodRpcClient, {
          reservationId, requestId: clientRequestId, fileSize: file.size, currentPeriodId: periodId, priorPeriodId: priorPeriod.id, currentEngagementId: engagementId,
        });
        uploadId = pair.currentUploadId;
        logAction({ action: "upload_trial_balance", entityType: "trial_balance_upload", entityId: pair.priorUploadId, metadata: { fileName: file.name, fileSize: file.size, sharedWith: uploadId } });
        // The prior year is its own dataset with its own check; it is started here and finished on its own page.
        const label = priorPeriod.period_label;
        setPriorNote(`${label} was saved from the same file; its check is running separately.`);
        void supabase.functions.invoke("process-trial-balance", { body: { uploadId: pair.priorUploadId, clientRequestId: crypto.randomUUID() } })
          .then(({ error: priorErr }) => setPriorNote(priorErr
            ? `${label} was saved from the same file, but its check did not finish. Open ${label} to run it again.`
            : `${label} was saved from the same file and checked separately. Open ${label} to see its result.`));
      } else {
        uploadId = await registerWorkspaceUpload({ reservationId, fileSize: file.size, periodYear: periodYear ?? null, periodId, engagementId });
      }
      dispatch({ type: "REGISTERED", uploadId });
      logAction({ action: "upload_trial_balance", entityType: "trial_balance_upload", entityId: uploadId, metadata: { fileName: file.name, fileSize: file.size } });
      await runCheck(uploadId, clientRequestId);
    } catch (e) {
      dispatch({ type: "FAILED", failure: classifySourceFailure("register", e as { code?: string; message?: string; retryable?: boolean }) });
    }
  }, [engagementId, includePrior, logAction, periodId, periodYear, priorPeriod, runCheck]);

  const runUpload = useCallback(async (clientRequestId: string) => {
    const file = fileRef.current;
    if (!file || !lockedCompanyId) return;
    try {
      const { reservationId } = await uploadWorkspaceSource(lockedCompanyId, file);
      dispatch({ type: "UPLOADED", reservationId });
      await runRegister(reservationId, clientRequestId);
    } catch (e) {
      dispatch({ type: "FAILED", failure: classifySourceFailure("upload", e as { code?: string; message?: string; retryable?: boolean }) });
    }
  }, [lockedCompanyId, runRegister]);

  // Upload is jurisdiction-neutral: no tax-registration field gates or warns here.
  const startProcessing = async () => {
    if (!user) {
      toast.error("Please sign in to upload a trial balance.");
      return;
    }
    if (!lockedCompanyId || flowRef.current.phase !== "selected") return;
    // One request id for this check, created once and reused by every retry of the same step.
    const clientRequestId = crypto.randomUUID();
    dispatch({ type: "START", clientRequestId });
    await runUpload(clientRequestId);
  };

  const retry = async () => {
    const before = flowRef.current;
    if (before.phase !== "failed" || !before.failure) return;
    // The same request id unless the server said it is spent (reduceFlow applies the same rule to the state).
    const fresh = crypto.randomUUID();
    const clientRequestId = before.failure.retry === "new_request" || !before.clientRequestId ? fresh : before.clientRequestId;
    dispatch({ type: "RETRY", newClientRequestId: fresh });
    const step = before.failure.step;
    if (step === "upload" || before.failure.retry === "start_over") await runUpload(clientRequestId);
    else if (step === "register" && before.reservationId) await runRegister(before.reservationId, clientRequestId);
    else if (step === "check" && before.uploadId) await runCheck(before.uploadId, clientRequestId);
  };

  const onAction = (id: FlowActionId) => {
    if (id === "choose" || id === "choose_other") fileInputRef.current?.click();
    else if (id === "start") void startProcessing();
    else if (id === "retry") void retry();
    else if (id === "remove") { fileRef.current = null; dispatch({ type: "CLEAR" }); }
  };

  // ── One-tap reupload: a file picked elsewhere is seeded, and started when autoProcess is set ────────────────────────
  const seededRef = useRef<File | null>(null);
  const autoStartRef = useRef(false);
  useEffect(() => {
    if (!initialFile || seededRef.current === initialFile) return;
    seededRef.current = initialFile;
    autoStartRef.current = autoProcess;
    void choose(initialFile);
  }, [initialFile, autoProcess, choose]);
  useEffect(() => {
    if (!autoStartRef.current || flow.phase !== "selected" || !user) return;
    autoStartRef.current = false;
    void startProcessing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.phase, user]);

  // ── Render ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const { primary, secondary } = actionsFor(flow);
  const steps = stepsFor(flow);
  const busy = isBusy(flow);
  const file = flow.file;

  return (
    <section id="upload" className="relative space-y-4" data-testid="trial-balance-upload" data-phase={flow.phase}>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(",")}
        className="hidden"
        data-testid="trial-balance-file-input"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          void choose(picked);
        }}
      />

      {!file && (
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); void choose(e.dataTransfer.files?.[0]); }}
          className={`border-2 border-dashed px-6 py-8 text-center transition-colors ${isDragging ? "border-primary bg-primary/5" : "border-border bg-card/50"}`}
          data-testid="trial-balance-drop-zone"
        >
          <Upload className="mx-auto mb-3 h-7 w-7 text-muted-foreground" aria-hidden="true" />
          <p className="text-[15px] font-semibold text-foreground">{isDragging ? "Drop the file to choose it" : "Upload the trial balance for this period"}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">One file · .xlsx, .xls or .csv · or drag it here</p>
        </div>
      )}

      {file && (
        <div className="flex items-center gap-3 border border-border bg-card px-4 py-3" data-testid="trial-balance-file-card">
          <FileSpreadsheet className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium text-foreground" title={file.name}>{file.name}</p>
            <p className="text-[12px] text-muted-foreground">
              {formatFileSize(file.size)}{periodYear ? ` · for FY${periodYear}` : ""}
              {file.previouslyCheckedAt && flow.phase === "selected" && (
                <> · a file with this name was checked on {new Date(file.previouslyCheckedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}; uploading again creates a new version</>
              )}
            </p>
          </div>
          {flow.phase === "selected" && (
            <button type="button" onClick={() => onAction("remove")} className="rounded p-1.5 hover:bg-secondary" aria-label={`Remove ${file.name}`}>
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>
      )}

      {priorPeriod && file && flow.phase === "selected" && (
        <div className="flex items-start gap-2 text-[13px]" data-testid="trial-balance-two-period">
          <input id="tb-include-prior" type="checkbox" className="mt-0.5" checked={includePrior} onChange={(e) => setIncludePrior(e.target.checked)} />
          <label htmlFor="tb-include-prior">
            This file also contains the prior year — save it for {priorPeriod.period_label} too.
            <span className="block text-[12px] text-muted-foreground">Each year is checked and reviewed on its own; the file is kept while either year uses it.</span>
          </label>
        </div>
      )}

      {priorNote && (
        <p role="status" className="text-[13px] text-muted-foreground" data-testid="trial-balance-prior-note">{priorNote}</p>
      )}

      {flow.choiceError && (
        <p role="alert" className="border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive" data-testid="trial-balance-choice-error">
          {flow.choiceError}
        </p>
      )}

      {steps.length > 0 && (
        <ol className="border border-border" aria-label="Upload progress" data-testid="trial-balance-upload-steps">
          {steps.map((s) => (
            <li key={s.id} className="flex gap-3 border-t border-border px-4 py-2.5 first:border-t-0" data-step={s.id} data-status={s.status} aria-current={s.status === "active" ? "step" : undefined}>
              <span className="mt-0.5 shrink-0">{STEP_ICON[s.status]}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className={`text-[13px] font-medium ${s.status === "pending" ? "text-muted-foreground" : "text-foreground"}`}>{s.label}</p>
                  <span className="text-[12px] text-muted-foreground">{STEP_WORD[s.status]}</span>
                </div>
                {s.detail && <p className="mt-0.5 text-[12px] text-muted-foreground">{s.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {flow.failure && (
        <p role="alert" className="border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] leading-relaxed text-destructive" data-testid="trial-balance-upload-error">
          {flow.failure.message}
        </p>
      )}

      {(primary || secondary.length > 0) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {primary && (
            <Button
              size="lg"
              onClick={() => onAction(primary.id)}
              disabled={busy}
              data-testid="trial-balance-upload-primary"
              className="h-auto min-h-11 w-full rounded-none px-5 py-2.5 text-[14px] font-semibold shadow-none sm:w-auto"
            >
              {primary.id === "choose" || primary.id === "start" ? <Upload className="mr-2 h-4 w-4" /> : null}
              {primary.label}
            </Button>
          )}
          {secondary.map((a) => (
            <Button key={a.id} variant="ghost" size="sm" onClick={() => onAction(a.id)} disabled={busy} className="text-muted-foreground">
              {a.label}
            </Button>
          ))}
        </div>
      )}


      <p className="text-[12px] text-muted-foreground">Stored in this workspace only · never shared</p>
    </section>
  );
};
