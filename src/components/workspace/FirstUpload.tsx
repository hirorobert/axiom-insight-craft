/**
 * FirstUpload — the one way to upload a trial balance from the account home (Phase 2 §5.4–5.5, §5.9; P2-3/P2-4):
 * drop the file → it is stored privately as a draft → the confirmation card (entity, period, currency) → ONE primary
 * action, "Start trial balance check".
 *
 *   · First visit: a full card. Returning (entities exist): `compact`, an outline action above the entity list, so the
 *     page keeps its one filled primary action.
 *   · Entity: a new one (when the plan allows) or an existing one the user can see. Choosing an existing entity
 *     pre-fills the currency from its CONFIRMED period, labelled with that source, and offers the following year as a
 *     suggestion (never pre-selected). Nothing is ever attached by name similarity or file hash.
 *   · No plan: the file can still be stored as a draft; "Start" explains that a plan is needed and leads to the plans
 *     page. On return the stored draft is offered again with what was entered (this browser only).
 *
 * Every write goes through an existing authority (src/lib/workspace/firstUpload.ts). The stages File read → Columns
 * confirmed → Checks completed are the SERVER's recorded milestones; nothing here reads the trial balance or shows a total.
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
import { UPLOAD_LIMITS_TEXT, fileTooLarge } from "@/lib/workspace/uploadPolicy";
import { DraftError, cancelDraftCommit, commitDraft, newDraftKey, reserveDraft, sha256Hex, uploadDraft } from "@/lib/workspace/trialBalanceDraft";
import { EMPTY_PERIOD, derivePeriod, followingYear, periodName, periodProblem, periodRange, periodYear, type PeriodChoice, type PeriodPreset } from "@/lib/workspace/reportingPeriod";
import { START_STEPS, STAGES, readMilestones, runStart, stagesFromMilestones, type ConfirmedStart, type StageStatus, type StartDeps, type StartKeys, type StartProgress, type StartResult, type StartStep } from "@/lib/workspace/firstUpload";

export const FIRST_UPLOAD_COPY = {
  heading: "Check your trial balance",
  intro: "Upload your trial balance to start. You confirm the entity, period and currency on the same page.",
  compactHeading: "Upload a trial balance",
  limits: UPLOAD_LIMITS_TEXT,
  choose: "Choose a file",
  storing: "Saving your file privately…",
  draft: "Stored privately as a draft. Not yet added to your entity.",
  needsPlan: "Checking a trial balance needs a plan. You can upload now: the file is kept privately as a draft while you choose one.",
  confirmHeading: "Confirm what this trial balance is for",
  start: "Start trial balance check",
} as const;

const PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: "year", label: "Year" }, { id: "quarter", label: "Quarter" }, { id: "month", label: "Month" }, { id: "custom", label: "Custom dates" },
];
const sizeWords = (b: number) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
const STATUS_WORD: Record<StageStatus, string> = { done: "Done", failed: "Stopped", needs_review: "Needs review", pending: "Not reached" };

interface FileMeta { name: string; size: number }
interface Draft { draftId: string }
type Phase =
  | { kind: "empty"; error?: string }
  | { kind: "storing"; file: FileMeta }
  | { kind: "stored"; file: FileMeta; draft: Draft }
  | { kind: "starting"; file: FileMeta; draft: Draft; step: StartStep }
  | { kind: "failed"; file: FileMeta; draft: Draft; result: Extract<StartResult, { kind: "failed" }> }
  | { kind: "checked"; file: FileMeta; draft: Draft; companyId: string; periodYear: number; stages: Record<"read" | "columns" | "checks", StageStatus> };

export interface UploadEntity { id: string; name: string }
interface ConfirmedPeriod { start: string; end: string; currency: string | null }
interface CardInput { mode: "new" | "existing"; entityName: string; existingId: string; period: PeriodChoice; currency: string }
const EMPTY_INPUT: CardInput = { mode: "new", entityName: "", existingId: "", period: EMPTY_PERIOD, currency: "" };

// What was entered on the card, kept in this browser only, so a customer who leaves to choose a plan finds it again.
const CARD_KEY = (draftId: string) => `cfoclose:tb-draft-card:${draftId}`;
const saveCard = (draftId: string, c: CardInput) => { try { sessionStorage.setItem(CARD_KEY(draftId), JSON.stringify(c)); } catch { /* storage unavailable */ } };
const loadCard = (draftId: string): CardInput | null => {
  try { const v = JSON.parse(sessionStorage.getItem(CARD_KEY(draftId)) ?? "null"); return v && typeof v === "object" ? { ...EMPTY_INPUT, ...v } : null; } catch { return null; }
};

export default function FirstUpload({ onChoosePlan, onOpenResult, entities = [], canCreateEntity = true, needsPlan = false, compact = false }: {
  onChoosePlan: () => void;
  onOpenResult: (companyId: string, periodYear: number) => void;
  /** Entities this user can see (the server re-checks every authority). */
  entities?: readonly UploadEntity[];
  /** False when the plan's entity capacity is in use: only an existing entity can be chosen. */
  canCreateEntity?: boolean;
  /** No current plan: the upload is still offered, with the plan stated up front. */
  needsPlan?: boolean;
  compact?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "empty" });
  const [input, setInput] = useState<CardInput>({ ...EMPTY_INPUT, mode: canCreateEntity || entities.length === 0 ? "new" : "existing" });
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [currencies, setCurrencies] = useState<{ code: string; name: string }[] | null>(null);
  const [confirmedPeriods, setConfirmedPeriods] = useState<ConfirmedPeriod[] | null>(null);
  const [currencySource, setCurrencySource] = useState<string | null>(null);
  const [resumable, setResumable] = useState<{ draftId: string; file: FileMeta } | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const keys = useRef<StartKeys | null>(null);
  const progress = useRef<StartProgress>({});
  const ids = { entity: useId(), existing: useId(), currency: useId(), filter: useId(), end: useId(), start: useId(), problems: useId() };
  // The card locks only once something durable exists for this attempt: a NEW entity created, or the period opened (the
  // commit comes after it). Before that, any change starts a fresh attempt: nothing recorded is bound to the old inputs.
  const durable = () => !!progress.current.periodId || (input.mode === "new" && !!progress.current.companyId);
  const set = (patch: Partial<CardInput>) => {
    if (!durable()) {
      progress.current = {}; keys.current = null;
      // A refusal is answered by changing the inputs: the card is ready to start again.
      if (phase.kind === "failed") setPhase({ kind: "stored", file: phase.file, draft: phase.draft });
    }
    setInput((c) => {
      const n = { ...c, ...patch };
      if (phase.kind === "stored" || phase.kind === "failed") saveCard(phase.draft.draftId, n);
      return n;
    });
  };

  // The supported currencies, from the server's registry (sorted by code; no ordering by presumed geography).
  useEffect(() => {
    let live = true;
    void (supabase.from("currency_registry" as never) as unknown as { select(c: string): { order(c: string): PromiseLike<{ data: { code: string; name: string }[] | null }> } })
      .select("code, name").order("code").then(({ data }) => { if (live) setCurrencies(data ?? []); });
    return () => { live = false; };
  }, []);

  // A draft already stored by this user (e.g. before choosing a plan) is offered again — never resumed silently.
  useEffect(() => {
    let live = true;
    void (supabase.rpc as unknown as (fn: string) => PromiseLike<{ data: { draft_id: string; file_name: string; file_size: number; state: string; stored: boolean }[] | null; error: unknown }>)("list_trial_balance_drafts")
      .then(({ data, error }) => {
        if (!live || error || !data) return; // an older backend without drafts simply offers no resume
        const d = data.find((x) => x.state === "reserved" && x.stored);
        if (d) setResumable({ draftId: d.draft_id, file: { name: d.file_name, size: Number(d.file_size) } });
      });
    return () => { live = false; };
  }, []);

  // An existing entity: its confirmed periods (dates and currency) — the only source the card pre-fills from.
  useEffect(() => {
    setConfirmedPeriods(null); setCurrencySource(null);
    if (input.mode !== "existing" || !input.existingId) return;
    let live = true;
    void (supabase.from("fiscal_periods") as unknown as { select(c: string): { eq(c: string, v: string): { order(c: string, o: { ascending: boolean }): PromiseLike<{ data: { reporting_start: string | null; reporting_end: string | null; reporting_currency: string | null }[] | null }> } } })
      .select("reporting_start, reporting_end, reporting_currency").eq("company_id", input.existingId).order("reporting_end", { ascending: false })
      .then(({ data }) => {
        if (!live) return;
        const confirmed = (data ?? []).filter((p): p is { reporting_start: string; reporting_end: string; reporting_currency: string | null } => !!p.reporting_start && !!p.reporting_end)
          .map((p) => ({ start: p.reporting_start, end: p.reporting_end, currency: p.reporting_currency }));
        setConfirmedPeriods(confirmed);
        const latest = confirmed[0];
        if (latest?.currency) {
          setInput((c) => (c.currency ? c : { ...c, currency: latest.currency! }));
          setCurrencySource(`From this entity's confirmed period ${periodRange(latest)}`);
        }
      });
    return () => { live = false; };
  }, [input.mode, input.existingId]);

  const locked = phase.kind === "starting" || phase.kind === "checked" || durable();
  const derived = derivePeriod(input.period);
  const existing = entities.find((e) => e.id === input.existingId) ?? null;
  const suggestion = confirmedPeriods?.[0] ? followingYear(confirmedPeriods[0]) : null;
  const problems = useMemo(() => {
    const p: { field: string; text: string }[] = [];
    if (input.mode === "new" && !input.entityName.trim()) p.push({ field: ids.entity, text: "Enter the entity's name." });
    if (input.mode === "existing" && !existing) p.push({ field: ids.existing, text: "Choose the entity." });
    const pp = periodProblem(input.period);
    if (pp) p.push({ field: ids.end, text: pp });
    if (!input.currency) p.push({ field: ids.currency, text: "Choose the trial balance currency." });
    return p;
  }, [input, existing, ids.entity, ids.existing, ids.end, ids.currency]);

  // ── The file: validated, hashed, reserved and stored as a draft (retry-safe: one key per file) ────────────────────
  const choose = async (file: File | null | undefined) => {
    if (!file || phase.kind === "storing" || locked) return;
    const invalid = validateFileChoice(file) ?? fileTooLarge(file);
    if (invalid) { setPhase({ kind: "empty", error: invalid }); return; }
    const meta = { name: file.name, size: file.size };
    setPhase({ kind: "storing", file: meta });
    try {
      await ensureFreshSession();
      const draft = await reserveDraft(file, newDraftKey(), await sha256Hex(file));
      await uploadDraft(draft, file);
      keys.current = null; progress.current = {};
      setResumable(null);
      setPhase({ kind: "stored", file: meta, draft: { draftId: draft.draftId } });
    } catch (e) {
      setPhase({ kind: "empty", error: e instanceof DraftError ? e.message : "The file could not be saved. Try again." });
    }
  };

  const resume = () => {
    if (!resumable) return;
    const saved = loadCard(resumable.draftId);
    if (saved) setInput(saved);
    keys.current = null; progress.current = {};
    setPhase({ kind: "stored", file: resumable.file, draft: { draftId: resumable.draftId } });
    setResumable(null);
  };

  // ── Start: the existing authorities in order; a retry resumes where the last attempt stopped ─────────────────────
  // The period already has an active trial balance and the user chose to replace it: cancel the refused commit (it was
  // never registered), then commit again bound to that exact upload at the version read now. The server replaces it in
  // one transaction (retire_trial_balance_upload) or changes nothing — the current trial balance is never lost.
  const replaces = useRef<{ uploadId: string; expectedVersion: number } | null>(null);
  const replace = async () => {
    if (phase.kind !== "failed" || phase.result.next !== "replace") return;
    const year = periodYear(input.period);
    const { data } = await supabase.from("trial_balance_uploads").select("id, version")
      .eq("company_id", progress.current.companyId ?? "").eq("period_year", year ?? 0)
      .in("lifecycle_state", ["active_unprocessed", "active_processing", "active_processed", "blocked"]).maybeSingle();
    const current = data as { id: string; version: number | string } | null;
    if (!current) { setPhase({ ...phase, result: { ...phase.result, message: "The trial balance for this period could not be found. Refresh and try again.", next: undefined, retryable: true } }); return; }
    try { if (phase.result.commitId) await cancelDraftCommit(phase.result.commitId); } catch { /* an already-cancelled commit is fine */ }
    replaces.current = { uploadId: current.id, expectedVersion: Number(current.version) };
    keys.current = { ...(keys.current ?? { entityRequestId: crypto.randomUUID(), checkRequestId: crypto.randomUUID() }), commitKey: newDraftKey(), checkRequestId: crypto.randomUUID() };
    await start(true);
  };

  const start = async (forceReplace = false) => {
    if (phase.kind !== "stored" && phase.kind !== "failed") return;
    if (problems.length) { setShowProblems(true); document.getElementById(ids.problems)?.focus(); return; }
    const { file, draft } = phase;
    saveCard(draft.draftId, input);
    keys.current ??= { entityRequestId: crypto.randomUUID(), commitKey: newDraftKey(), checkRequestId: crypto.randomUUID() };
    const p = derived!;
    const confirmed: ConfirmedStart = {
      draftId: draft.draftId,
      entity: input.mode === "existing" && existing ? { kind: "existing", companyId: existing.id, name: existing.name } : { kind: "new", name: input.entityName },
      period: { start: p.start, end: p.end, year: periodYear(input.period)!, name: periodName(input.period)! }, currency: input.currency,
      replaces: forceReplace || replaces.current ? replaces.current : null,
    };
    const client = supabase as unknown as RpcClient;
    const deps: StartDeps = {
      createEntity: async (a) => {
        const { data, error } = await supabase.rpc("create_entity" as never, { p_request_id: a.requestId, p_name: a.name, p_fiscal_year_end: a.fiscalYearEnd, p_currency: a.currency, p_reporting_framework: null } as never);
        if (error) throw new Error("The entity could not be saved. Try again.");
        return parseCreateEntityOutcome(data);
      },
      openPeriod: (a) => openEngagementWithPeriod(client, { companyId: a.companyId, periodStart: a.start, periodEnd: a.end, reportingCurrency: a.currency, capabilities: ["FINANCIAL_STATEMENTS"] }),
      commit: (a) => commitDraft(a.draftId, a.commitKey, { companyId: a.companyId, periodYear: a.periodYear, periodId: a.periodId, engagementId: a.engagementId, confirmation: a.confirmation, replaces: a.replaces }),
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
    setPhase({ kind: "starting", file, draft, step: progress.current.companyId || confirmed.entity.kind === "existing" ? "period" : "entity" });
    const r = await runStart(deps, confirmed, keys.current, progress.current, (step) => setPhase({ kind: "starting", file, draft, step }));
    progress.current = r.progress;
    if (r.kind === "failed") { setPhase({ kind: "failed", file, draft, result: r }); return; }
    try { sessionStorage.removeItem(CARD_KEY(draft.draftId)); } catch { /* */ }
    const { data } = await supabase.from("trial_balance_uploads").select("processing_result").eq("id", r.progress.uploadId).maybeSingle();
    const stages = stagesFromMilestones(readMilestones((data as { processing_result?: unknown } | null)?.processing_result));
    setPhase({ kind: "checked", file, draft, companyId: r.progress.companyId, periodYear: r.periodYear, stages });
  };

  const reset = () => { keys.current = null; progress.current = {}; replaces.current = null; setInput({ ...EMPTY_INPUT, mode: canCreateEntity || entities.length === 0 ? "new" : "existing" }); setPhase({ kind: "empty" }); };

  // ── Render ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const filtered = (currencies ?? []).filter((c) => !currencyFilter || `${c.code} ${c.name}`.toLowerCase().includes(currencyFilter.toLowerCase()) || c.code === input.currency);
  const file = phase.kind === "empty" ? null : phase.file;

  return (
    <SurfaceCard data-testid="first-upload" data-compact={compact ? "true" : undefined}>
      <h2 className={compact ? "text-[15px] font-semibold text-foreground" : "text-xl font-semibold text-foreground"}>{compact ? FIRST_UPLOAD_COPY.compactHeading : FIRST_UPLOAD_COPY.heading}</h2>
      {!compact && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">{FIRST_UPLOAD_COPY.intro}</p>}
      {needsPlan && (
        <p className="mt-2 max-w-2xl text-[14px] text-foreground" data-testid="first-upload-needs-plan">
          {FIRST_UPLOAD_COPY.needsPlan}{" "}
          <button type="button" onClick={onChoosePlan} className="underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="first-upload-view-plans">
            View plans
          </button>
        </p>
      )}

      {(phase.kind === "empty" || phase.kind === "storing") && (
        <div
          className={compact ? "mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border border-dashed border-border bg-background px-4 py-3" : "mt-6 border-2 border-dashed border-border bg-background px-5 py-8 text-center"}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); void choose(e.dataTransfer.files?.[0]); }}
          data-testid="first-upload-dropzone"
        >
          {!compact && <Upload className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" />}
          <p className={compact ? "text-[14px] text-foreground" : "mt-2 text-[14px] text-foreground"}>Drop the file here, or</p>
          <input ref={fileInput} type="file" accept={ACCEPTED_EXTENSIONS.join(",")} className="sr-only" id="first-upload-file" aria-label="Choose a trial balance file" tabIndex={-1}
            onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} data-testid="first-upload-input" />
          <Button variant={compact ? "outline" : "default"} className={compact ? "" : "mt-3"} onClick={() => fileInput.current?.click()} disabled={phase.kind === "storing"} data-testid="first-upload-choose">
            {phase.kind === "storing" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {phase.kind === "storing" ? FIRST_UPLOAD_COPY.storing : FIRST_UPLOAD_COPY.choose}
          </Button>
          <p className={compact ? "text-[13px] text-muted-foreground" : "mt-3 text-[13px] text-muted-foreground"} data-testid="first-upload-limits">{FIRST_UPLOAD_COPY.limits}</p>
          {phase.kind === "empty" && resumable && (
            <p className={compact ? "basis-full text-[14px]" : "mt-3 text-[14px]"}>
              <button type="button" onClick={resume} className="underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="first-upload-resume">
                Continue with “{resumable.file.name}”
              </button>{" "}
              <span className="text-muted-foreground">(saved privately as a draft)</span>
            </p>
          )}
          {phase.kind === "empty" && phase.error && (
            <p role="alert" className={compact ? "basis-full text-[14px] text-destructive" : "mt-3 text-[14px] text-destructive"} data-testid="first-upload-error">{phase.error}</p>
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

          <fieldset disabled={locked}>
            <legend className="text-[14px] font-medium text-foreground">Entity</legend>
            {entities.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2" role="radiogroup">
                {canCreateEntity && (
                  <label className="flex items-center gap-2 text-[14px]">
                    <input type="radio" name="first-upload-entity" checked={input.mode === "new"} onChange={() => set({ mode: "new" })} data-testid="confirm-entity-new" />
                    New entity
                  </label>
                )}
                <label className="flex items-center gap-2 text-[14px]">
                  <input type="radio" name="first-upload-entity" checked={input.mode === "existing"} onChange={() => set({ mode: "existing" })} data-testid="confirm-entity-existing" />
                  Choose an existing entity
                </label>
              </div>
            )}
            {input.mode === "new" ? (
              <div className="mt-2">
                <Label htmlFor={ids.entity}>Entity name</Label>
                <Input id={ids.entity} value={input.entityName} onChange={(e) => set({ entityName: e.target.value })} placeholder="The business or organisation this trial balance belongs to"
                  className="mt-1 bg-white" autoComplete="organization" data-testid="confirm-entity" />
              </div>
            ) : (
              <div className="mt-2">
                <Label htmlFor={ids.existing}>Existing entity</Label>
                <select id={ids.existing} value={input.existingId} onChange={(e) => set({ existingId: e.target.value, currency: "" })}
                  className="mt-1 h-10 w-full border border-input bg-white px-3 text-[14px]" data-testid="confirm-entity-select">
                  <option value="">Choose the entity</option>
                  {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
            )}
          </fieldset>

          <fieldset disabled={locked}>
            <legend className="text-[14px] font-medium text-foreground">Period</legend>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2" role="radiogroup">
              {PRESETS.map((pr) => (
                <label key={pr.id} className="flex items-center gap-2 text-[14px]">
                  <input type="radio" name="first-upload-period" value={pr.id} checked={input.period.preset === pr.id}
                    onChange={() => set({ period: { ...input.period, preset: pr.id } })} data-testid={`confirm-period-${pr.id}`} />
                  {pr.label}
                </label>
              ))}
            </div>
            {suggestion && !locked && (
              <button type="button" onClick={() => set({ period: suggestion })} className="mt-2 text-[14px] underline underline-offset-4" data-testid="confirm-period-suggestion">
                Suggested: {periodName(suggestion)} (next after {periodRange(confirmedPeriods![0])})
              </button>
            )}
            {input.period.preset && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {input.period.preset === "custom" && (
                  <div>
                    <Label htmlFor={ids.start}>Starts on</Label>
                    <Input id={ids.start} type="date" value={input.period.start ?? ""} onChange={(e) => set({ period: { ...input.period, start: e.target.value || null } })} className="mt-1 bg-white" data-testid="confirm-period-start" />
                  </div>
                )}
                <div>
                  <Label htmlFor={ids.end}>Ends on</Label>
                  <Input id={ids.end} type="date" value={input.period.end ?? ""} onChange={(e) => set({ period: { ...input.period, end: e.target.value || null } })} className="mt-1 bg-white" data-testid="confirm-period-end" />
                </div>
              </div>
            )}
            {derived && !periodProblem(input.period) && (
              <p className="mt-2 text-[14px] text-foreground" data-testid="confirm-period-derived">
                {periodName(input.period)} <span className="text-muted-foreground">· {periodRange(derived)}</span>
              </p>
            )}
          </fieldset>

          <div>
            <Label htmlFor={ids.currency}>Trial balance currency</Label>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              <Input id={ids.filter} aria-label="Search currencies" placeholder="Search by code or name" value={currencyFilter} disabled={locked}
                onChange={(e) => setCurrencyFilter(e.target.value)} className="bg-white" data-testid="confirm-currency-search" />
              <select id={ids.currency} value={input.currency} onChange={(e) => { set({ currency: e.target.value }); setCurrencySource(null); }} disabled={locked || currencies === null}
                className="h-10 border border-input bg-white px-3 text-[14px]" data-testid="confirm-currency">
                <option value="">{currencies === null ? "Loading currencies…" : "Choose the currency"}</option>
                {filtered.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
              </select>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground" data-testid="confirm-currency-source">
              {currencySource && input.currency ? currencySource : "The currency the trial balance amounts are in. Nothing is assumed from the entity's country."}
            </p>
          </div>

          {phase.kind === "failed" && (
            <div role="alert" className="flex gap-2 border border-border bg-background px-4 py-3 text-[14px]" data-testid="first-upload-failure">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <p>{phase.result.message}</p>
            </div>
          )}

          {phase.kind === "starting" && <StepList current={phase.step} />}

          {phase.kind === "failed" && phase.result.next === "replace" ? (
            <Button type="button" onClick={() => void replace()} data-testid="first-upload-replace">Replace the current trial balance with this file</Button>
          ) : phase.kind === "failed" && phase.result.next === "choose_plan" ? (
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
