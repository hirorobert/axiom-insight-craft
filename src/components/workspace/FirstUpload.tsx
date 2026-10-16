/**
 * FirstUpload — the first visit (Phase 2 §5.4–5.5, P2-3): one upload action, the file stored privately as a draft, the
 * confirmation card (entity, period, currency) and ONE primary action, "Start trial balance check".
 *
 * Every write goes through an existing authority (see src/lib/workspace/firstUpload.ts): the draft (trial-balance-draft),
 * create_entity, open_engagement_with_period, the draft commit and process-trial-balance. The stages File read →
 * Columns confirmed → Checks completed are the SERVER's recorded milestones; nothing here reads the trial balance or
 * shows a total. No field is pre-filled without evidence; nothing is guessed.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckCircle2, Circle, FileSpreadsheet, Loader2, Upload, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { supabase } from "@/integrations/supabase/client";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { ACCEPTED_EXTENSIONS, classifyCheckAnswer, validateFileChoice } from "@/lib/ingestion/uploadFlow";
import { parseCreateEntityOutcome } from "@/lib/commercial/entityCreation";
import { openEngagementWithPeriod, type RpcClient } from "@/lib/workspace/workspaceSetupClient";
import { DRAFT_MAX_BYTES, DraftError, commitDraft, newDraftKey, reserveDraft, sha256Hex, uploadDraft, type ReservedDraft } from "@/lib/workspace/trialBalanceDraft";
import { EMPTY_PERIOD, derivePeriod, periodName, periodProblem, periodRange, periodYear, type PeriodChoice, type PeriodPreset } from "@/lib/workspace/reportingPeriod";
import { START_STEPS, STAGES, readMilestones, runStart, stagesFromMilestones, type StageStatus, type StartDeps, type StartKeys, type StartProgress, type StartResult, type StartStep } from "@/lib/workspace/firstUpload";

export const FIRST_UPLOAD_COPY = {
  heading: "Check your trial balance",
  intro: "Upload your trial balance to start. You confirm the entity, period and currency on the same page.",
  limits: `CSV or Excel (${ACCEPTED_EXTENSIONS.join(", ")}), up to ${DRAFT_MAX_BYTES / 1048576} MB.`,
  choose: "Choose a file",
  storing: "Saving your file privately…",
  draft: "Stored privately as a draft. Not yet added to your entity.",
  confirmHeading: "Confirm what this trial balance is for",
  start: "Start trial balance check",
} as const;

const PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: "year", label: "Year" }, { id: "quarter", label: "Quarter" }, { id: "month", label: "Month" }, { id: "custom", label: "Custom dates" },
];
const sizeWords = (b: number) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
const STATUS_WORD: Record<StageStatus, string> = { done: "Done", failed: "Stopped", needs_review: "Needs review", pending: "Not reached" };

type Phase =
  | { kind: "empty"; error?: string }
  | { kind: "storing"; file: File }
  | { kind: "stored"; file: File; draft: ReservedDraft }
  | { kind: "starting"; file: File; draft: ReservedDraft; step: StartStep }
  | { kind: "failed"; file: File; draft: ReservedDraft; result: Extract<StartResult, { kind: "failed" }> }
  | { kind: "checked"; file: File; draft: ReservedDraft; companyId: string; periodYear: number; stages: Record<"read" | "columns" | "checks", StageStatus> };

export default function FirstUpload({ onChoosePlan, onOpenResult }: {
  onChoosePlan: () => void;
  onOpenResult: (companyId: string, periodYear: number) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "empty" });
  const [entityName, setEntityName] = useState("");
  const [period, setPeriod] = useState<PeriodChoice>(EMPTY_PERIOD);
  const [currency, setCurrency] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [currencies, setCurrencies] = useState<{ code: string; name: string }[] | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftKey = useRef<string | null>(null);
  const keys = useRef<StartKeys | null>(null);
  const progress = useRef<StartProgress>({});
  const ids = { entity: useId(), currency: useId(), filter: useId(), end: useId(), start: useId(), problems: useId() };

  // The supported currencies, from the server's registry (sorted by code; no ordering by presumed geography).
  useEffect(() => {
    let live = true;
    void (supabase.from("currency_registry" as never) as unknown as { select(c: string): { order(c: string): PromiseLike<{ data: { code: string; name: string }[] | null }> } })
      .select("code, name").order("code").then(({ data }) => { if (live) setCurrencies(data ?? []); });
    return () => { live = false; };
  }, []);

  const locked = phase.kind === "starting" || phase.kind === "checked" || !!progress.current.companyId;
  const derived = derivePeriod(period);
  const problems = useMemo(() => {
    const p: { field: string; text: string }[] = [];
    if (!entityName.trim()) p.push({ field: ids.entity, text: "Enter the entity's name." });
    const pp = periodProblem(period);
    if (pp) p.push({ field: ids.end, text: pp });
    if (!currency) p.push({ field: ids.currency, text: "Choose the trial balance currency." });
    return p;
  }, [entityName, period, currency, ids.entity, ids.end, ids.currency]);

  // ── The file: validated, hashed, reserved and stored as a draft (retry-safe: one key per file) ────────────────────
  const choose = async (file: File | null | undefined) => {
    if (!file || phase.kind === "storing" || locked) return;
    const invalid = validateFileChoice(file) ?? (file.size > DRAFT_MAX_BYTES ? `“${file.name}” is larger than ${DRAFT_MAX_BYTES / 1048576} MB. Export a smaller file and upload it.` : null);
    if (invalid) { setPhase({ kind: "empty", error: invalid }); return; }
    setPhase({ kind: "storing", file });
    draftKey.current = newDraftKey();
    try {
      await ensureFreshSession();
      const draft = await reserveDraft(file, draftKey.current, await sha256Hex(file));
      await uploadDraft(draft, file);
      keys.current = null; progress.current = {};
      setPhase({ kind: "stored", file, draft });
    } catch (e) {
      setPhase({ kind: "empty", error: e instanceof DraftError ? e.message : "The file could not be saved. Try again." });
    }
  };

  // ── Start: the existing authorities in order; a retry resumes where the last attempt stopped ─────────────────────
  const start = async () => {
    if (phase.kind !== "stored" && phase.kind !== "failed") return;
    if (problems.length) { setShowProblems(true); document.getElementById(ids.problems)?.focus(); return; }
    const { file, draft } = phase;
    keys.current ??= { entityRequestId: crypto.randomUUID(), commitKey: newDraftKey(), checkRequestId: crypto.randomUUID() };
    const p = derived!;
    const confirmed = {
      draftId: draft.draftId, entity: { kind: "new" as const, name: entityName },
      period: { start: p.start, end: p.end, year: periodYear(period)!, name: periodName(period)! }, currency,
    };
    const client = supabase as unknown as RpcClient;
    const deps: StartDeps = {
      createEntity: async (a) => {
        const { data, error } = await supabase.rpc("create_entity" as never, { p_request_id: a.requestId, p_name: a.name, p_fiscal_year_end: a.fiscalYearEnd, p_currency: a.currency, p_reporting_framework: null } as never);
        if (error) throw new Error("The entity could not be saved. Try again.");
        return parseCreateEntityOutcome(data);
      },
      openPeriod: (a) => openEngagementWithPeriod(client, { companyId: a.companyId, periodStart: a.start, periodEnd: a.end, reportingCurrency: a.currency, capabilities: ["FINANCIAL_STATEMENTS"] }),
      commit: (a) => commitDraft(a.draftId, a.commitKey, { companyId: a.companyId, periodYear: a.periodYear, periodId: a.periodId, engagementId: a.engagementId, confirmation: a.confirmation }),
      check: async (a) => {
        await ensureFreshSession();
        const { error } = await supabase.functions.invoke("process-trial-balance", { body: { uploadId: a.uploadId, clientRequestId: a.requestId } });
        if (!error) return classifyCheckAnswer({ httpStatus: 200, body: null });
        const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown> } }).context;
        let body: Record<string, unknown> | null = null;
        try { body = ((await ctx?.json?.()) ?? null) as Record<string, unknown> | null; } catch { body = null; }
        return classifyCheckAnswer({ httpStatus: typeof ctx?.status === "number" ? ctx.status : null, body });
      },
    };
    setPhase({ kind: "starting", file, draft, step: progress.current.companyId ? "period" : "entity" });
    const r = await runStart(deps, confirmed, keys.current, progress.current, (step) => setPhase({ kind: "starting", file, draft, step }));
    progress.current = r.progress;
    if (r.kind === "failed") { setPhase({ kind: "failed", file, draft, result: r }); return; }
    const { data } = await supabase.from("trial_balance_uploads").select("processing_result").eq("id", r.progress.uploadId).maybeSingle();
    const stages = stagesFromMilestones(readMilestones((data as { processing_result?: unknown } | null)?.processing_result));
    setPhase({ kind: "checked", file, draft, companyId: r.progress.companyId, periodYear: r.periodYear, stages });
  };

  const reset = () => { draftKey.current = null; keys.current = null; progress.current = {}; setPhase({ kind: "empty" }); };

  // ── Render ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const filtered = (currencies ?? []).filter((c) => !currencyFilter || `${c.code} ${c.name}`.toLowerCase().includes(currencyFilter.toLowerCase()));
  const file = phase.kind === "empty" ? null : phase.file;

  return (
    <SurfaceCard data-testid="first-upload">
      <h2 className="text-xl font-semibold text-foreground">{FIRST_UPLOAD_COPY.heading}</h2>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">{FIRST_UPLOAD_COPY.intro}</p>

      {(phase.kind === "empty" || phase.kind === "storing") && (
        <div
          className="mt-6 border-2 border-dashed border-border bg-background px-5 py-8 text-center"
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); void choose(e.dataTransfer.files?.[0]); }}
          data-testid="first-upload-dropzone"
        >
          <Upload className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <p className="mt-2 text-[14px] text-foreground">Drop the file here, or</p>
          <input ref={fileInput} type="file" accept={ACCEPTED_EXTENSIONS.join(",")} className="sr-only" id="first-upload-file" aria-label="Choose a trial balance file" tabIndex={-1}
            onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} data-testid="first-upload-input" />
          <Button className="mt-3" onClick={() => fileInput.current?.click()} disabled={phase.kind === "storing"} data-testid="first-upload-choose">
            {phase.kind === "storing" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {phase.kind === "storing" ? FIRST_UPLOAD_COPY.storing : FIRST_UPLOAD_COPY.choose}
          </Button>
          <p className="mt-3 text-[13px] text-muted-foreground" data-testid="first-upload-limits">{FIRST_UPLOAD_COPY.limits}</p>
          {phase.kind === "empty" && phase.error && (
            <p role="alert" className="mt-3 text-[14px] text-destructive" data-testid="first-upload-error">{phase.error}</p>
          )}
        </div>
      )}

      {file && phase.kind !== "storing" && (
        <div className="mt-6 flex flex-wrap items-center gap-3 border border-border bg-background px-4 py-3" data-testid="first-upload-file-card">
          <FileSpreadsheet className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium text-foreground">{file.name}</p>
            <p className="text-[13px] text-muted-foreground" data-testid="first-upload-draft-note">{sizeWords(file.size)} · {FIRST_UPLOAD_COPY.draft}</p>
          </div>
          {!locked && (
            <button type="button" onClick={reset} className="text-[13px] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="first-upload-change-file">
              Use a different file
            </button>
          )}
        </div>
      )}

      {(phase.kind === "stored" || phase.kind === "starting" || phase.kind === "failed") && (
        <form className="mt-6 space-y-5" onSubmit={(e) => { e.preventDefault(); void start(); }} data-testid="first-upload-confirm" noValidate>
          <h3 className="text-[15px] font-semibold text-foreground">{FIRST_UPLOAD_COPY.confirmHeading}</h3>
          {showProblems && problems.length > 0 && (
            <div id={ids.problems} tabIndex={-1} role="alert" className="border border-destructive/60 bg-background px-4 py-3" data-testid="first-upload-problems">
              <p className="text-[14px] font-medium text-foreground">Before the check can start:</p>
              <ul className="mt-1 list-disc pl-5 text-[14px]">
                {problems.map((p) => <li key={p.field}><a href={`#${p.field}`} className="underline underline-offset-4">{p.text}</a></li>)}
              </ul>
            </div>
          )}

          <div>
            <Label htmlFor={ids.entity}>Entity name</Label>
            <Input id={ids.entity} value={entityName} onChange={(e) => setEntityName(e.target.value)} disabled={locked} placeholder="The business or organisation this trial balance belongs to"
              className="mt-1 bg-white" autoComplete="organization" data-testid="confirm-entity" />
          </div>

          <fieldset disabled={locked}>
            <legend className="text-[14px] font-medium text-foreground">Period</legend>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2" role="radiogroup">
              {PRESETS.map((pr) => (
                <label key={pr.id} className="flex items-center gap-2 text-[14px]">
                  <input type="radio" name="first-upload-period" value={pr.id} checked={period.preset === pr.id}
                    onChange={() => setPeriod((c) => ({ ...c, preset: pr.id }))} data-testid={`confirm-period-${pr.id}`} />
                  {pr.label}
                </label>
              ))}
            </div>
            {period.preset && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {period.preset === "custom" && (
                  <div>
                    <Label htmlFor={ids.start}>Starts on</Label>
                    <Input id={ids.start} type="date" value={period.start ?? ""} onChange={(e) => setPeriod((c) => ({ ...c, start: e.target.value || null }))} className="mt-1 bg-white" data-testid="confirm-period-start" />
                  </div>
                )}
                <div>
                  <Label htmlFor={ids.end}>Ends on</Label>
                  <Input id={ids.end} type="date" value={period.end ?? ""} onChange={(e) => setPeriod((c) => ({ ...c, end: e.target.value || null }))} className="mt-1 bg-white" data-testid="confirm-period-end" />
                </div>
              </div>
            )}
            {derived && !periodProblem(period) && (
              <p className="mt-2 text-[14px] text-foreground" data-testid="confirm-period-derived">
                {periodName(period)} <span className="text-muted-foreground">· {periodRange(derived)}</span>
              </p>
            )}
          </fieldset>

          <div>
            <Label htmlFor={ids.currency}>Trial balance currency</Label>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              <Input id={ids.filter} aria-label="Search currencies" placeholder="Search by code or name" value={currencyFilter} disabled={locked}
                onChange={(e) => setCurrencyFilter(e.target.value)} className="bg-white" data-testid="confirm-currency-search" />
              <select id={ids.currency} value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={locked || currencies === null}
                className="h-10 border border-input bg-white px-3 text-[14px]" data-testid="confirm-currency">
                <option value="">{currencies === null ? "Loading currencies…" : "Choose the currency"}</option>
                {filtered.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
              </select>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">The currency the trial balance amounts are in. Nothing is assumed from the entity's country.</p>
          </div>

          {phase.kind === "failed" && (
            <div role="alert" className="flex gap-2 border border-border bg-background px-4 py-3 text-[14px]" data-testid="first-upload-failure">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <p>{phase.result.message}</p>
            </div>
          )}

          {phase.kind === "starting" && <StepList current={phase.step} />}

          {phase.kind === "failed" && phase.result.next === "choose_plan" ? (
            <Button type="button" onClick={onChoosePlan} data-testid="first-upload-choose-plan">Choose a plan</Button>
          ) : phase.kind === "failed" && phase.result.next === "upload_again" ? (
            <Button type="button" onClick={reset} data-testid="first-upload-again">Upload the file again</Button>
          ) : phase.kind === "failed" && !phase.result.retryable ? null : (
            <Button type="submit" disabled={phase.kind === "starting"} data-testid="first-upload-start">
              {phase.kind === "starting" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {phase.kind === "failed" ? "Try again" : FIRST_UPLOAD_COPY.start}
            </Button>
          )}
        </form>
      )}

      {phase.kind === "checked" && (
        <div className="mt-6" data-testid="first-upload-checked">
          <ol className="space-y-2" aria-label="Check stages">
            {STAGES.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-[14px]" data-testid={`first-upload-stage-${s.id}`}>
                <StageIcon status={phase.stages[s.id]} />
                <span className="text-foreground">{s.label}</span>
                <span className="text-muted-foreground">· {STATUS_WORD[phase.stages[s.id]]}</span>
              </li>
            ))}
          </ol>
          <Button className="mt-5" onClick={() => onOpenResult(phase.companyId, phase.periodYear)} data-testid="first-upload-open-result">See the result</Button>
        </div>
      )}
    </SurfaceCard>
  );
}

function StepList({ current }: { current: StartStep }) {
  const at = START_STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="space-y-1.5" aria-live="polite" data-testid="first-upload-steps">
      {START_STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2 text-[14px]">
          {i < at ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" /> : i === at ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" /> : <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />}
          <span>{s.label}</span>
          <span className="text-muted-foreground">· {i < at ? "Done" : i === at ? "In progress" : "Waiting"}</span>
        </li>
      ))}
    </ol>
  );
}

function StageIcon({ status }: { status: StageStatus }) {
  if (status === "done") return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />;
  if (status === "needs_review") return <AlertCircle className="h-4 w-4 text-warning" aria-hidden="true" />;
  return <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />;
}
