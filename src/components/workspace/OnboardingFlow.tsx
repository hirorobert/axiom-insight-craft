/**
 * OnboardingFlow — the 3-step first-run path through the workspace.
 *
 *   1. Upload trial balance
 *   2. Set TIN / company details
 *   3. Generate statements
 *
 * Completion is DERIVED from the database (upload status, company.tin,
 * statements mission) — never invented locally. localStorage only remembers
 * where the user was and whether they dismissed the panel, so a refresh
 * resumes on the same step instead of restarting.
 *
 * Design law: exactly ONE primary button on screen. The current step owns it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight, Check, Upload, Building2, FileText, Eye, X, Loader2, CloudOff, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type OnboardingStepId = "upload" | "company" | "statements" | "review";

type Persisted = {
  /** Step the user was last working on — restored on refresh. */
  currentStep: OnboardingStepId;
  /** True once the user explicitly dismisses the guide. */
  dismissed: boolean;
  /** Steps the user has explicitly marked as reached, for resume ordering. */
  reached: OnboardingStepId[];
  /** True once the user has previewed the mapped statements + compliance notes. */
  reviewed: boolean;
  updatedAt: string;
};

const STEP_ORDER: OnboardingStepId[] = ["upload", "company", "statements", "review"];

function storageKey(companyId: string, periodYear: number) {
  return `saff.onboarding.v1.${companyId}.${periodYear}`;
}

function readPersisted(companyId: string, periodYear: number): Persisted {
  const fallback: Persisted = {
    currentStep: "upload",
    dismissed: false,
    reached: ["upload"],
    reviewed: false,
    updatedAt: new Date().toISOString(),
  };
  try {
    const raw = localStorage.getItem(storageKey(companyId, periodYear));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      currentStep: STEP_ORDER.includes(parsed.currentStep as OnboardingStepId)
        ? (parsed.currentStep as OnboardingStepId)
        : fallback.currentStep,
      dismissed: parsed.dismissed === true,
      reviewed: parsed.reviewed === true,
      reached: Array.isArray(parsed.reached)
        ? parsed.reached.filter((s): s is OnboardingStepId => STEP_ORDER.includes(s as OnboardingStepId))
        : fallback.reached,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
    };
  } catch {
    return fallback;
  }
}

function writePersisted(companyId: string, periodYear: number, value: Persisted) {
  try {
    localStorage.setItem(storageKey(companyId, periodYear), JSON.stringify(value));
  } catch {
    /* storage unavailable — progress simply won't persist */
  }
}

/* ── Offline outbox ───────────────────────────────────────────────────────────
 * A step change made without connectivity is never lost and never rolled back:
 * the local record stays authoritative and the exact state that still owes a
 * backend write is parked here. It survives a refresh, and the flusher drains
 * it the moment the browser reports connectivity again.
 */

function pendingKey(companyId: string, periodYear: number) {
  return `${storageKey(companyId, periodYear)}.pending`;
}

function readPending(companyId: string, periodYear: number): Persisted | null {
  try {
    const raw = localStorage.getItem(pendingKey(companyId, periodYear));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (!STEP_ORDER.includes(parsed.currentStep as OnboardingStepId)) return null;
    return {
      currentStep: parsed.currentStep as OnboardingStepId,
      dismissed: parsed.dismissed === true,
      reviewed: parsed.reviewed === true,
      reached: Array.isArray(parsed.reached)
        ? parsed.reached.filter((s): s is OnboardingStepId => STEP_ORDER.includes(s as OnboardingStepId))
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function writePending(companyId: string, periodYear: number, value: Persisted) {
  try {
    localStorage.setItem(pendingKey(companyId, periodYear), JSON.stringify(value));
  } catch {
    /* storage unavailable — the write simply cannot be deferred */
  }
}

function clearPending(companyId: string, periodYear: number) {
  try {
    localStorage.removeItem(pendingKey(companyId, periodYear));
  } catch {
    /* nothing to do */
  }
}

/**
 * Backend copy of the same state, so the indicator survives a new device or a
 * cleared browser. localStorage stays as the instant-read cache; the row in
 * `onboarding_progress` is the durable truth and wins on conflict.
 */
async function fetchRemote(userId: string, companyId: string, periodYear: number) {
  const { data, error } = await supabase
    .from("onboarding_progress")
    .select("current_step, dismissed, reviewed, updated_at")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .eq("period_year", periodYear)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function saveRemote(
  userId: string,
  companyId: string,
  periodYear: number,
  value: Persisted
): Promise<{ error: unknown }> {
  const { error } = await supabase.from("onboarding_progress").upsert(
    {
      user_id: userId,
      company_id: companyId,
      period_year: periodYear,
      current_step: value.currentStep,
      dismissed: value.dismissed,
      reviewed: value.reviewed,
    },
    { onConflict: "user_id,company_id,period_year" }
  );
  return { error };
}

export default function OnboardingFlow({
  companyId,
  periodYear,
  basePath,
  uploadDone,
  uploadPending,
  companyDone,
  statementsDone,
  onSetTin,
  onVisibilityChange,
}: {
  companyId: string;
  periodYear: number;
  basePath: string;
  /** Trial balance uploaded and validated. */
  uploadDone: boolean;
  /** Trial balance uploaded but still processing / needs attention. */
  uploadPending: boolean;
  /** TRA TIN present and well formed. */
  companyDone: boolean;
  /** Statements prepared (passed or signed). */
  statementsDone: boolean;
  onSetTin: () => void;
  /** Lets the parent restore its normal directive when the guide hides itself. */
  onVisibilityChange?: (visible: boolean) => void;
}) {
  const { user } = useAuth();
  const [persisted, setPersisted] = useState<Persisted>(() => readPersisted(companyId, periodYear));
  /** True once the durable row has been read, so a save cannot clobber it. */
  const [hydrated, setHydrated] = useState(false);
  /**
   * Optimistic write status — the UI never waits on this.
   *  idle    — local and backend agree
   *  saving  — backend write in flight
   *  pending — held in the offline outbox, will sync automatically
   */
  const [sync, setSync] = useState<"idle" | "saving" | "pending">("idle");
  /** Timestamp of the last confirmed backend sync. Displayed to the user. */
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  /** True while the user explicitly pressed Sync now. */
  const [isForceSyncing, setIsForceSyncing] = useState(false);
  /** Monotonic write counter: only the newest save may alter UI state. */
  const seqRef = useRef(0);
  /** Writes made before hydration finished, flushed once it does. */
  const queuedRef = useRef<Persisted | null>(null);
  /** Guard so overlapping flush triggers (online + interval) don't double-send. */
  const flushingRef = useRef(false);

  // Re-read when the engagement changes — progress is per company + year.
  useEffect(() => {
    const pending = readPending(companyId, periodYear);
    setPersisted(pending ?? readPersisted(companyId, periodYear));
    setHydrated(false);
    setSync(pending ? "pending" : "idle");
    queuedRef.current = null;
  }, [companyId, periodYear]);

  // Hydrate from the backend — durable across refreshes and devices.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      // An unsynced local write is newer than anything on the server: keep it
      // and let the flusher push it, rather than hydrating over the top.
      if (readPending(companyId, periodYear)) {
        setHydrated(true);
        return;
      }
      const remote = await fetchRemote(user.id, companyId, periodYear);
      if (cancelled) return;
      if (remote) {
        const next: Persisted = {
          currentStep: STEP_ORDER.includes(remote.current_step as OnboardingStepId)
            ? (remote.current_step as OnboardingStepId)
            : "upload",
          dismissed: remote.dismissed === true,
          reviewed: remote.reviewed === true,
          reached: [],
          updatedAt: remote.updated_at ?? new Date().toISOString(),
        };
        next.reached = Array.from(
          new Set([...STEP_ORDER.slice(0, STEP_ORDER.indexOf(next.currentStep) + 1)])
        );
        setPersisted(next);
        writePersisted(companyId, periodYear, next);
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, companyId, periodYear]);

  /**
   * Fire the durable write in the background. The optimistic state is already on
   * screen and stays there: if the device is offline or the write fails, the
   * state moves to the outbox instead of being rolled back.
   * Stale responses are discarded so a slow earlier save cannot undo a newer one.
   */
  const push = useCallback(
    async (next: Persisted) => {
      if (!user) return;
      const seq = ++seqRef.current;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        writePending(companyId, periodYear, next);
        setSync("pending");
        return;
      }
      setSync("saving");
      const { error } = await saveRemote(user.id, companyId, periodYear, next);
      if (seq !== seqRef.current) return; // superseded by a newer write
      if (error) {
        writePending(companyId, periodYear, next);
        setSync("pending");
        return;
      }
      clearPending(companyId, periodYear);
      setSync("idle");
      setLastSyncAt(new Date());
    },
    [user, companyId, periodYear]
  );

  /**
   * Single write path. State and the local cache update synchronously so the
   * indicator moves on the same frame as the click; the backend catches up.
   */
  const commit = useCallback(
    (next: Persisted) => {
      setPersisted(next);
      writePersisted(companyId, periodYear, next);
      if (!user) return;
      if (!hydrated) {
        queuedRef.current = next;
        return;
      }
      void push(next);
    },
    [companyId, periodYear, user, hydrated, push]
  );

  // Flush anything the user did while the durable row was still loading.
  useEffect(() => {
    if (!hydrated || !user) return;
    const queued = queuedRef.current;
    if (!queued) return;
    queuedRef.current = null;
    void push(queued);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, user]);

  /** Drain the offline outbox. Safe to call repeatedly. */
  const flush = useCallback(async () => {
    if (!user || flushingRef.current) return;
    const pending = readPending(companyId, periodYear);
    if (!pending) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    flushingRef.current = true;
    try {
      await push(pending);
    } finally {
      flushingRef.current = false;
    }
  }, [user, companyId, periodYear, push]);

  /** Explicit user-triggered sync. Shows its own loading state and records the time on success. */
  const forceSync = useCallback(async () => {
    if (!user) return;
    setIsForceSyncing(true);
    try {
      await flush();
    } finally {
      setIsForceSyncing(false);
    }
  }, [user, flush]);

  // Automatic sync: on reconnect, on tab focus, and on a slow poll while the
  // outbox is non-empty (covers flaky links where `online` never fires).
  useEffect(() => {
    if (!hydrated || !user) return;
    void flush();
    const onOnline = () => void flush();
    const onVisible = () => {
      if (document.visibilityState === "visible") void flush();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => void flush(), 20_000);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [hydrated, user, flush]);

  const done: Record<OnboardingStepId, boolean> = useMemo(
    () => ({
      upload: uploadDone,
      company: companyDone,
      statements: statementsDone,
      review: statementsDone && persisted.reviewed,
    }),
    [uploadDone, companyDone, statementsDone, persisted.reviewed]
  );

  const allDone = STEP_ORDER.every((s) => done[s]);

  // The live step: first incomplete step, but never behind where the user
  // already was (so a resumed session lands where they left off).
  const firstIncomplete = STEP_ORDER.find((s) => !done[s]) ?? "review";
  const rememberedIndex = STEP_ORDER.indexOf(persisted.currentStep);
  const incompleteIndex = STEP_ORDER.indexOf(firstIncomplete);
  const activeStep = STEP_ORDER[Math.max(incompleteIndex, done[persisted.currentStep] ? incompleteIndex : rememberedIndex)];

  // Persist the resolved position so a refresh restores it.
  useEffect(() => {
    if (persisted.currentStep === activeStep && persisted.reached.includes(activeStep)) return;
    const next: Persisted = {
      ...persisted,
      currentStep: activeStep,
      reached: Array.from(new Set([...persisted.reached, activeStep])),
      updatedAt: new Date().toISOString(),
    };
    commit(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, companyId, periodYear, hydrated]);

  const dismiss = () => {
    const next: Persisted = { ...persisted, dismissed: true, updatedAt: new Date().toISOString() };
    commit(next);
  };

  const markReviewed = () => {
    if (persisted.reviewed) return;
    const next: Persisted = { ...persisted, reviewed: true, updatedAt: new Date().toISOString() };
    commit(next);
  };

  const visible = !persisted.dismissed && !allDone;

  useEffect(() => {
    onVisibilityChange?.(visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  const completedCount = STEP_ORDER.filter((s) => done[s]).length;
  const activeIndex = STEP_ORDER.indexOf(activeStep);

  const STEP_TITLES: Record<OnboardingStepId, string> = {
    upload: "Trial balance",
    company: "TIN & company",
    statements: "Statements",
    review: "Review",
  };

  const steps: Array<{
    id: OnboardingStepId;
    title: string;
    detail: string;
    icon: React.ReactNode;
    action: { label: string; href?: string; onClick?: () => void };
    secondary?: { label: string; href: string; onClick?: () => void };
  }> = [
    {
      id: "upload",
      title: "Upload the trial balance",
      detail: uploadPending
        ? "Uploaded — validation is running. Status updates on its own."
        : "Excel or CSV. Validated against the Tanzania chart of accounts before anything else runs.",
      icon: <Upload className="w-4 h-4" />,
      action: { label: uploadPending ? "Open Prepare Data" : "Upload trial balance", href: `${basePath}/prepare` },
    },
    {
      id: "company",
      title: "Set the TIN and company details",
      detail: "The 9-digit TRA TIN is required before any filing pack or export can be produced.",
      icon: <Building2 className="w-4 h-4" />,
      action: { label: "Set TIN", onClick: onSetTin },
    },
    {
      id: "statements",
      title: "Generate the statements",
      detail: "Statement of financial position, profit or loss, and the disclosure notes.",
      icon: <FileText className="w-4 h-4" />,
      action: { label: "Open Statements", href: `${basePath}/statements` },
    },
    {
      id: "review",
      title: "Preview the mapped statements and compliance notes",
      detail:
        "Check every mapped account, the drafted statements, and the compliance notes before anything is signed or filed.",
      icon: <Eye className="w-4 h-4" />,
      action: { label: "Preview statements", href: `${basePath}/statements`, onClick: markReviewed },
      secondary: { label: "View compliance notes", href: `${basePath}/compliance`, onClick: markReviewed },
    },
  ];

  return (
    <section className="mb-14 border border-border">
      <header className="flex items-start justify-between gap-6 px-5 py-4 border-b border-border">
        <div>
          <p className="text-[10px] font-semibold text-primary tracking-[0.22em] uppercase">
            Getting started · Step {activeIndex + 1} of {STEP_ORDER.length}
          </p>
          <p className="mt-2 text-[15px] font-medium text-foreground tracking-tight">
            {STEP_TITLES[activeStep]} — {completedCount === STEP_ORDER.length ? "all steps complete" : "in progress"}
          </p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
            {completedCount} of {STEP_ORDER.length} done
          </span>
          {sync === "saving" && (
            <span
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 whitespace-nowrap"
              aria-live="polite"
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving
            </span>
          )}
          {sync === "pending" && (
            <span
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground whitespace-nowrap"
              aria-live="polite"
              title="Your progress is saved on this device and will sync automatically when you are back online."
            >
              <CloudOff className="w-3 h-3" />
              Saved offline
              <button
                type="button"
                onClick={() => void flush()}
                className="underline underline-offset-2 font-medium hover:text-foreground transition-colors"
              >
                Sync now
              </button>
            </span>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="text-muted-foreground/60 hover:text-foreground transition-colors"
            title="Hide this guide"
            aria-label="Hide getting started guide"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Progress indicator — labelled segments with explicit completion state */}
      <ol className="grid grid-cols-4 border-b border-border" aria-label="Onboarding progress">
        {STEP_ORDER.map((s, i) => {
          const isDone = done[s];
          const isActive = !isDone && s === activeStep;
          return (
            <li
              key={s}
              aria-current={isActive ? "step" : undefined}
              className={[
                "px-3 pt-3 pb-2.5 border-r border-border last:border-r-0",
                isActive ? "bg-primary/[0.04]" : "",
              ].join(" ")}
            >
              <div className="flex items-center gap-1.5">
                {isDone ? (
                  <Check className="w-3 h-3 text-success shrink-0" />
                ) : (
                  <span
                    className={[
                      "text-[10px] font-mono tabular-nums shrink-0",
                      isActive ? "text-primary font-semibold" : "text-muted-foreground/50",
                    ].join(" ")}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                )}
                <span
                  className={[
                    "text-[11px] truncate tracking-tight",
                    isDone ? "text-success" : isActive ? "text-primary font-medium" : "text-muted-foreground/60",
                  ].join(" ")}
                >
                  {STEP_TITLES[s]}
                </span>
              </div>
              <div
                className={[
                  "mt-2 h-0.5",
                  isDone ? "bg-success" : isActive ? "bg-primary" : "bg-border",
                ].join(" ")}
              />
              <p
                className={[
                  "mt-1.5 text-[10px] uppercase tracking-[0.14em] font-semibold",
                  isDone ? "text-success" : isActive ? "text-primary" : "text-muted-foreground/40",
                ].join(" ")}
              >
                {isDone ? "Done" : isActive ? "Current" : "Pending"}
              </p>
            </li>
          );
        })}
      </ol>

      <ol>
        {steps.map((step, i) => {
          const isDone = done[step.id];
          const isActive = !isDone && step.id === activeStep;
          const isFuture = !isDone && !isActive;

          return (
            <li key={step.id} className="border-b border-border last:border-b-0">
              <div className={[
                "grid grid-cols-[2rem_1fr] gap-4 px-5 py-4",
                isActive ? "bg-primary/[0.03]" : "",
              ].join(" ")}>
                <div className="pt-0.5">
                  <span className={[
                    "flex items-center justify-center w-7 h-7 border text-[11px] font-mono tabular-nums",
                    isDone
                      ? "border-success text-success"
                      : isActive
                        ? "border-primary text-primary font-semibold"
                        : "border-border text-muted-foreground/50",
                  ].join(" ")}>
                    {isDone ? <Check className="w-3.5 h-3.5" /> : String(i + 1).padStart(2, "0")}
                  </span>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={isDone ? "text-success" : isActive ? "text-primary" : "text-muted-foreground/40"}>
                      {step.icon}
                    </span>
                    <p className={[
                      "text-[15px] font-medium tracking-tight leading-tight",
                      isFuture ? "text-muted-foreground" : "text-foreground",
                    ].join(" ")}>
                      {step.title}
                    </p>
                    {isDone && (
                      <span className="text-[11px] text-success tracking-wide uppercase font-semibold">Done</span>
                    )}
                  </div>

                  {!isDone && (
                    <p className="mt-2 text-[13px] text-muted-foreground leading-relaxed max-w-xl">
                      {step.detail}
                    </p>
                  )}

                  {isActive && (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      {step.action.href ? (
                        <Button
                          asChild
                          size="lg"
                          className="h-11 px-5 text-[14px] font-semibold rounded-none shadow-none"
                        >
                          <Link to={step.action.href} onClick={step.action.onClick}>
                            <span className="mr-2">{step.action.label}</span>
                            <ArrowRight className="w-4 h-4" />
                          </Link>
                        </Button>
                      ) : (
                        <Button
                          onClick={step.action.onClick}
                          size="lg"
                          className="h-11 px-5 text-[14px] font-semibold rounded-none shadow-none"
                        >
                          <span className="mr-2">{step.action.label}</span>
                          <ArrowRight className="w-4 h-4" />
                        </Button>
                      )}
                      {step.secondary && (
                        <Link
                          to={step.secondary.href}
                          onClick={step.secondary.onClick}
                          className="text-[13px] font-medium text-muted-foreground hover:text-foreground underline underline-offset-4 transition-colors"
                        >
                          {step.secondary.label}
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="px-5 py-3 text-[11px] text-muted-foreground/70 border-t border-border">
        Progress is saved automatically — close the tab and you will come back to this step.
      </p>
    </section>
  );
}