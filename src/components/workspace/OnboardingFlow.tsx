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
import {
  ArrowRight,
  Check,
  Upload,
  Building2,
  FileText,
  Eye,
  X,
  Loader2,
  CloudOff,
  RefreshCw,
  Download,
} from "lucide-react";
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
 *
 * The outbox keeps a small log of pending updates so the user can inspect what
 * is queued, how many times each item has been retried, and what the last
 * failure was. Only the newest item needs to reach the server — older entries
 * are superseded but remain visible until the queue drains.
 */

type OutboxEntry = {
  /** Stable id so the UI can key rows and retry individual items. */
  id: string;
  /** Snapshot of the onboarding state at the time it was queued. */
  persisted: Persisted;
  /** ISO timestamp when this snapshot entered the outbox. */
  enqueuedAt: string;
  /** Number of times this snapshot has been sent to the backend. */
  attempts: number;
  /** Human-readable error from the last failed attempt, if any. */
  lastError: string | null;
  /** Current outbox status for this snapshot. */
  status: "pending" | "failed";
};

function pendingKey(companyId: string, periodYear: number) {
  return `${storageKey(companyId, periodYear)}.pending`;
}

function normalizePersisted(value: Partial<Persisted>): Persisted | null {
  if (!STEP_ORDER.includes(value.currentStep as OnboardingStepId)) return null;
  return {
    currentStep: value.currentStep as OnboardingStepId,
    dismissed: value.dismissed === true,
    reviewed: value.reviewed === true,
    reached: Array.isArray(value.reached)
      ? value.reached.filter((s): s is OnboardingStepId => STEP_ORDER.includes(s as OnboardingStepId))
      : [],
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function readPending(companyId: string, periodYear: number): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(pendingKey(companyId, periodYear));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;

    // Backward compatibility: the legacy outbox stored a single Persisted object.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const normalized = normalizePersisted(parsed as Partial<Persisted>);
      if (!normalized) return [];
      return [
        {
          id: `legacy-${Date.now()}`,
          persisted: normalized,
          enqueuedAt: normalized.updatedAt,
          attempts: 0,
          lastError: null,
          status: "pending",
        },
      ];
    }

    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: unknown) => {
        const e = entry as Partial<OutboxEntry>;
        const persisted = normalizePersisted((e.persisted ?? {}) as Partial<Persisted>);
        if (!persisted) return null;
        return {
          id: typeof e.id === "string" ? e.id : crypto.randomUUID(),
          persisted,
          enqueuedAt: typeof e.enqueuedAt === "string" ? e.enqueuedAt : persisted.updatedAt,
          attempts: typeof e.attempts === "number" ? Math.max(0, e.attempts) : 0,
          lastError: typeof e.lastError === "string" ? e.lastError : null,
          status: e.status === "failed" ? "failed" : "pending",
        };
      })
      .filter((e): e is OutboxEntry => e !== null);
  } catch {
    return [];
  }
}

function writePendingEntries(companyId: string, periodYear: number, entries: OutboxEntry[]) {
  try {
    localStorage.setItem(pendingKey(companyId, periodYear), JSON.stringify(entries));
  } catch {
    /* storage unavailable — the write simply cannot be deferred */
  }
}

function appendPending(companyId: string, periodYear: number, value: Persisted, error?: unknown) {
  const entries = readPending(companyId, periodYear);
  const last = entries[entries.length - 1];
  // If the newest queued snapshot matches this one, update its attempt/error
  // metadata instead of creating a duplicate row.
  if (last && last.persisted.updatedAt === value.updatedAt) {
    last.attempts += 1;
    last.lastError = error ? String(error) : last.lastError;
    last.status = error ? "failed" : "pending";
    writePendingEntries(companyId, periodYear, entries);
    return;
  }
  entries.push({
    id: crypto.randomUUID(),
    persisted: value,
    enqueuedAt: new Date().toISOString(),
    attempts: 1,
    lastError: error ? String(error) : null,
    status: error ? "failed" : "pending",
  });
  writePendingEntries(companyId, periodYear, entries);
}

function clearPending(companyId: string, periodYear: number) {
  try {
    localStorage.removeItem(pendingKey(companyId, periodYear));
  } catch {
    /* nothing to do */
  }
}

function removePendingEntry(companyId: string, periodYear: number, id: string) {
  const entries = readPending(companyId, periodYear).filter((e) => e.id !== id);
  writePendingEntries(companyId, periodYear, entries);
}

/** Human-readable relative sync time (e.g. "just now", "2m ago"). */
function formatSyncTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ── Sync attempt history ───────────────────────────────────────────────────
 * A rolling log of every backend save attempt so support can see not just what
 * is queued now, but how we got here. Capped at 100 entries to avoid unbounded
 * growth in localStorage.
 */

type SyncHistoryEntry = {
  id: string;
  attemptedAt: string;
  success: boolean;
  error: string | null;
  online: boolean;
  step: OnboardingStepId;
};

function historyKey(companyId: string, periodYear: number) {
  return `${storageKey(companyId, periodYear)}.history`;
}

function readHistory(companyId: string, periodYear: number): SyncHistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(companyId, periodYear));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: unknown) => {
        const e = entry as Partial<SyncHistoryEntry>;
        const step = e.step as OnboardingStepId;
        if (!STEP_ORDER.includes(step)) return null;
        return {
          id: typeof e.id === "string" ? e.id : crypto.randomUUID(),
          attemptedAt: typeof e.attemptedAt === "string" ? e.attemptedAt : new Date().toISOString(),
          success: e.success === true,
          error: typeof e.error === "string" ? e.error : null,
          online: e.online === true,
          step,
        };
      })
      .filter((e): e is SyncHistoryEntry => e !== null);
  } catch {
    return [];
  }
}

function writeHistory(companyId: string, periodYear: number, entries: SyncHistoryEntry[]) {
  try {
    localStorage.setItem(historyKey(companyId, periodYear), JSON.stringify(entries));
  } catch {
    /* storage unavailable — history simply won't persist */
  }
}

function appendHistory(
  companyId: string,
  periodYear: number,
  entry: Omit<SyncHistoryEntry, "id">
) {
  const entries = readHistory(companyId, periodYear);
  entries.unshift({ id: crypto.randomUUID(), ...entry });
  if (entries.length > 100) entries.length = 100;
  writeHistory(companyId, periodYear, entries);
}

/* ── Export helpers ───────────────────────────────────────────────────────────
 * Produce a support bundle of the current outbox queue and recent sync history
 * as CSV or JSON. No secrets or tokens are included.
 */

function escapeCsvCell(value: string): string {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildOutboxCsv(entries: OutboxEntry[], history: SyncHistoryEntry[]): string {
  const lines: string[] = [];
  lines.push(
    ["Queue ID", "Step", "Enqueued At", "Attempts", "Status", "Last Error", "Dismissed", "Reviewed", "Updated At"]
      .map(escapeCsvCell)
      .join(",")
  );
  entries.forEach((entry) => {
    lines.push(
      [
        entry.id,
        entry.persisted.currentStep,
        entry.enqueuedAt,
        String(entry.attempts),
        entry.status,
        entry.lastError ?? "",
        entry.persisted.dismissed ? "yes" : "no",
        entry.persisted.reviewed ? "yes" : "no",
        entry.persisted.updatedAt,
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  });
  lines.push("");
  lines.push("Sync attempt history");
  lines.push(["Attempted At", "Step", "Success", "Online", "Error"].map(escapeCsvCell).join(","));
  history.forEach((entry) => {
    lines.push(
      [entry.attemptedAt, entry.step, entry.success ? "yes" : "no", entry.online ? "yes" : "no", entry.error ?? ""]
        .map(escapeCsvCell)
        .join(",")
    );
  });
  return lines.join("\n");
}

function buildSupportBundle(
  companyId: string,
  periodYear: number,
  entries: OutboxEntry[],
  history: SyncHistoryEntry[],
  meta: Record<string, unknown>
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      companyId,
      periodYear,
      meta,
      queue: entries.map((entry) => ({
        id: entry.id,
        step: entry.persisted.currentStep,
        enqueuedAt: entry.enqueuedAt,
        attempts: entry.attempts,
        status: entry.status,
        lastError: entry.lastError,
        dismissed: entry.persisted.dismissed,
        reviewed: entry.persisted.reviewed,
        updatedAt: entry.persisted.updatedAt,
      })),
      history: history.map((entry) => ({
        id: entry.id,
        attemptedAt: entry.attemptedAt,
        step: entry.step,
        success: entry.success,
        online: entry.online,
        error: entry.error,
      })),
    },
    null,
    2
  );
}

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadSupportBundle(
  type: "csv" | "json",
  companyId: string,
  periodYear: number,
  entries: OutboxEntry[],
  history: SyncHistoryEntry[],
  meta: Record<string, unknown>
) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = `saff-onboarding-${companyId.slice(0, 8)}-${periodYear}-${stamp}`;
  if (type === "csv") {
    triggerDownload(buildOutboxCsv(entries, history), `${slug}.csv`, "text/csv;charset=utf-8;");
  } else {
    triggerDownload(
      buildSupportBundle(companyId, periodYear, entries, history, meta),
      `${slug}.json`,
      "application/json"
    );
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
  /** Live view of the offline outbox for the detailed queue UI. */
  const [outbox, setOutbox] = useState<OutboxEntry[]>(() => readPending(companyId, periodYear));
  /** Recent sync attempt history for support export. */
  const [history, setHistory] = useState<SyncHistoryEntry[]>(() => readHistory(companyId, periodYear));
  /** Whether the detailed outbox queue panel is expanded. */
  const [outboxOpen, setOutboxOpen] = useState(false);
  /** Monotonic write counter: only the newest save may alter UI state. */
  const seqRef = useRef(0);
  /** Writes made before hydration finished, flushed once it does. */
  const queuedRef = useRef<Persisted | null>(null);
  /** Guard so overlapping flush triggers (online + interval) don't double-send. */
  const flushingRef = useRef(false);

  // Re-read when the engagement changes — progress is per company + year.
  useEffect(() => {
    const pending = readPending(companyId, periodYear);
    setOutbox(pending);
    setHistory(readHistory(companyId, periodYear));
    setPersisted(pending.length > 0 ? pending[pending.length - 1].persisted : readPersisted(companyId, periodYear));
    setHydrated(false);
    setSync(pending.length > 0 ? "pending" : "idle");
    queuedRef.current = null;
  }, [companyId, periodYear]);

  // Hydrate from the backend — durable across refreshes and devices.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      // An unsynced local write is newer than anything on the server: keep it
      // and let the flusher push it, rather than hydrating over the top.
      const pending = readPending(companyId, periodYear);
      if (pending.length > 0) {
        setOutbox(pending);
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
        appendPending(companyId, periodYear, next);
        appendHistory(companyId, periodYear, {
          attemptedAt: new Date().toISOString(),
          success: false,
          error: "Device offline",
          online: false,
          step: next.currentStep,
        });
        setOutbox(readPending(companyId, periodYear));
        setHistory(readHistory(companyId, periodYear));
        setSync("pending");
        return;
      }
      setSync("saving");
      const { error } = await saveRemote(user.id, companyId, periodYear, next);
      if (seq !== seqRef.current) return; // superseded by a newer write
      if (error) {
        appendPending(companyId, periodYear, next, error);
        appendHistory(companyId, periodYear, {
          attemptedAt: new Date().toISOString(),
          success: false,
          error: String(error),
          online: true,
          step: next.currentStep,
        });
        setOutbox(readPending(companyId, periodYear));
        setHistory(readHistory(companyId, periodYear));
        setSync("pending");
        return;
      }
      clearPending(companyId, periodYear);
      appendHistory(companyId, periodYear, {
        attemptedAt: new Date().toISOString(),
        success: true,
        error: null,
        online: true,
        step: next.currentStep,
      });
      setOutbox([]);
      setHistory(readHistory(companyId, periodYear));
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
    if (pending.length === 0) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    flushingRef.current = true;
    try {
      // Only the newest snapshot matters — older entries are superseded.
      await push(pending[pending.length - 1].persisted);
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

  /** Retry one specific outbox entry (useful when the user wants to retry an older snapshot). */
  const retryEntry = useCallback(
    async (entry: OutboxEntry) => {
      if (!user) return;
      setIsForceSyncing(true);
      try {
        await push(entry.persisted);
      } finally {
        setIsForceSyncing(false);
      }
    },
    [user, push]
  );

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

  const exportMeta: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    sync,
    lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
    online: typeof navigator !== "undefined" ? navigator.onLine : null,
    currentStep: persisted.currentStep,
    reached: persisted.reached,
    dismissed: persisted.dismissed,
    reviewed: persisted.reviewed,
  };

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

          {/* Sync status + explicit drain control */}
          <div className="flex items-center gap-3">
            {sync === "saving" || isForceSyncing ? (
              <span
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 whitespace-nowrap"
                aria-live="polite"
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                {isForceSyncing ? "Syncing now" : "Saving"}
              </span>
            ) : sync === "pending" ? (
              <span
                className="flex items-center gap-1.5 text-[11px] text-amber-600 whitespace-nowrap"
                aria-live="polite"
                title="Your progress is saved on this device and will sync automatically when you are back online."
              >
                <CloudOff className="w-3 h-3" />
                Saved offline
              </span>
            ) : lastSyncAt ? (
              <span
                className="hidden sm:inline text-[11px] text-muted-foreground/70 whitespace-nowrap"
                aria-live="polite"
              >
                Last synced {formatSyncTime(lastSyncAt)}
              </span>
            ) : null}

            {outbox.length > 0 && (
              <button
                type="button"
                onClick={() => setOutboxOpen((v) => !v)}
                className="text-[11px] font-medium text-primary underline underline-offset-2 hover:text-foreground transition-colors whitespace-nowrap"
                aria-expanded={outboxOpen}
                aria-controls="onboarding-outbox-panel"
              >
                View queue ({outbox.length})
              </button>
            )}

            <Button
              type="button"
              variant={sync === "pending" ? "default" : "outline"}
              size="sm"
              disabled={!user || sync === "saving" || isForceSyncing || (typeof navigator !== "undefined" && navigator.onLine === false)}
              onClick={() => void forceSync()}
              className="h-8 px-3 text-[12px] font-semibold rounded-none gap-1.5"
              aria-label="Sync onboarding progress now"
            >
              {isForceSyncing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Sync now
            </Button>
          </div>

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

      {/* Detailed offline outbox queue */}
      {outboxOpen && outbox.length > 0 && (
        <div
          id="onboarding-outbox-panel"
          className="border-b border-border bg-amber-50/30 dark:bg-amber-950/10 px-5 py-4"
        >
          <div className="flex items-center justify-between gap-4 mb-3">
            <div>
              <p className="text-[12px] font-semibold text-foreground tracking-tight">Offline outbox queue</p>
              <p className="text-[11px] text-muted-foreground">
                {outbox.length} pending update{outbox.length === 1 ? "" : "s"} waiting to sync
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-3 text-[12px] font-semibold rounded-none gap-1.5"
                onClick={() => downloadSupportBundle("csv", companyId, periodYear, outbox, history, exportMeta)}
              >
                <Download className="w-3.5 h-3.5" />
                Export CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-3 text-[12px] font-semibold rounded-none gap-1.5"
                onClick={() => downloadSupportBundle("json", companyId, periodYear, outbox, history, exportMeta)}
              >
                <Download className="w-3.5 h-3.5" />
                Export JSON
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isForceSyncing || (typeof navigator !== "undefined" && navigator.onLine === false)}
                onClick={() => void forceSync()}
                className="h-8 px-3 text-[12px] font-semibold rounded-none gap-1.5"
              >
                {isForceSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Retry all
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 pr-4 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Step</th>
                  <th className="py-2 pr-4 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Queued</th>
                  <th className="py-2 pr-4 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Attempts</th>
                  <th className="py-2 pr-4 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="py-2 pr-4 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Last error</th>
                  <th className="py-2 text-right text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {outbox.map((entry) => (
                  <tr key={entry.id} className="border-b border-border last:border-b-0">
                    <td className="py-2.5 pr-4 text-[12px] font-medium text-foreground whitespace-nowrap">
                      {STEP_TITLES[entry.persisted.currentStep]}
                    </td>
                    <td className="py-2.5 pr-4 text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                      {formatSyncTime(new Date(entry.enqueuedAt))}
                    </td>
                    <td className="py-2.5 pr-4 text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                      {entry.attempts}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      <span
                        className={[
                          "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide",
                          entry.status === "failed" ? "text-destructive" : "text-amber-600",
                        ].join(" ")}
                      >
                        {entry.status === "failed" ? (
                          <>
                            <X className="w-3 h-3" /> Failed
                          </>
                        ) : (
                          <>
                            <CloudOff className="w-3 h-3" /> Pending
                          </>
                        )}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-[11px] text-destructive max-w-[200px] truncate" title={entry.lastError ?? undefined}>
                      {entry.lastError ?? "—"}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={isForceSyncing || (typeof navigator !== "undefined" && navigator.onLine === false)}
                          onClick={() => void retryEntry(entry)}
                          className="text-[11px] font-medium text-primary hover:text-foreground underline underline-offset-2 disabled:opacity-50 disabled:no-underline transition-colors"
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            removePendingEntry(companyId, periodYear, entry.id);
                            setOutbox(readPending(companyId, periodYear));
                          }}
                          className="text-[11px] font-medium text-muted-foreground hover:text-destructive underline underline-offset-2 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {typeof navigator !== "undefined" && navigator.onLine === false && (
            <p className="mt-3 text-[11px] text-amber-600 flex items-center gap-1.5">
              <CloudOff className="w-3 h-3" />
              Device is offline. Retries will resume automatically when connectivity returns.
            </p>
          )}
        </div>
      )}

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