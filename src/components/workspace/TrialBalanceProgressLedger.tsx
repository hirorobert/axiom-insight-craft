/**
 * TrialBalanceProgressLedger — live 7-step ingestion ledger.
 *
 * Read-only. Derives every step purely from the upload row already fetched by
 * useWorkspaceData; it never writes and never infers a result the engine has
 * not produced (null processing_result = NOT COMPUTED, not "failed").
 *
 * The ledger updates in place as the row moves:
 *   Uploaded → Processing → Completed | Failed
 */

import { useEffect, useState } from "react";
import { Check, X, Loader2, Minus, AlertTriangle } from "lucide-react";
import type { WorkspaceUpload } from "@/hooks/useWorkspaceData";
import { formatCents, isOutOfBalance, readTrialBalanceTotals } from "@/lib/workspace/trialBalanceVerdict";
import {
  SurfaceCard,
  SurfaceCardHeader,
  LedgerRow,
  StatusMark,
  type Tone,
} from "@/components/workspace/ui/Surface";

type StepState = "pending" | "running" | "done" | "failed" | "attention";

export interface LedgerStep {
  key: string;
  label: string;
  detail?: string;
  state: StepState;
}

const PROCESSING_STATES = ["processing", "queued", "pending", "needs_review"];
const FAILED_STATES = ["blocked", "error", "failed"];
const DONE_STATES = ["complete", "valid"];

function pluralAccounts(n: number) {
  return `${n.toLocaleString("en-TZ")} account${n === 1 ? "" : "s"}`;
}

/** The verdict's failing check → the ledger step it belongs to (trialBalanceVerdict.ts is the authority). */
const STEP_FOR_CHECK: Record<string, string> = {
  l1_structure: "parsed",
  l2_data_quality: "parsed",
  l3_arithmetic: "balanced",
  l4_classification: "classified",
};

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * Pure derivation — exported for reuse/testing. Classification coverage comes from
 * validation_report.mapping_completeness (mapped / needs-review), never summary.auto_classified (Tier 4-5 fuzzy matches
 * only). The balance step reads the recorded totals. When the run is blocked, the failed step is the verdict's failing
 * check (failedCheckId), never simply "the first step not yet done".
 */
export function deriveTrialBalanceSteps(upload: WorkspaceUpload | null, opts: { failedCheckId?: string | null } = {}): LedgerStep[] {
  const base: Array<{ key: string; label: string }> = [
    { key: "received",   label: "File received" },
    { key: "queued",     label: "Queued for processing" },
    { key: "parsed",     label: "Workbook parsed" },
    { key: "classified", label: "Accounts classified" },
    { key: "balanced",   label: "Debits equal credits" },
    { key: "statements", label: "Draft statements assembled" },
    { key: "complete",   label: "Validation complete" },
  ];

  if (!upload) {
    return base.map((s) => ({ ...s, state: "pending" as StepState }));
  }

  const status = (upload.status ?? "").toLowerCase();
  const isFailed = FAILED_STATES.includes(status);
  const isDone = DONE_STATES.includes(status);
  const isProcessing = PROCESSING_STATES.includes(status);

  const pr = (upload.processing_result ?? null) as
    | { summary?: Record<string, unknown>; statements?: unknown; validation_report?: Record<string, unknown> }
    | null;
  const summary = pr?.summary ?? null;
  const report = (pr?.validation_report ?? (upload.validation_report as Record<string, unknown> | null) ?? null) as Record<string, unknown> | null;
  const mc = (report?.mapping_completeness ?? null) as Record<string, unknown> | null;

  const totalAccounts = count(mc?.total_accounts) ?? count(summary?.total_accounts);
  const mapped = count(mc?.mapped_accounts);
  const needsReview = count(mc?.needs_review);
  const totals = readTrialBalanceTotals(pr);
  const outOfBalance = isOutOfBalance(totals);

  const classifiedKnown = mapped !== null && totalAccounts !== null;
  const unresolved = classifiedKnown ? Math.max(needsReview ?? 0, totalAccounts - mapped) : null;

  const reached: Record<string, boolean> = {
    received: true,
    queued: status !== "pending",
    parsed: totalAccounts !== null,
    classified: classifiedKnown && unresolved === 0,
    balanced: totals !== null && !outOfBalance,
    statements: !!pr?.statements,
    complete: isDone,
  };

  const details: Record<string, string | undefined> = {
    received: upload.file_name,
    parsed: totalAccounts !== null ? pluralAccounts(totalAccounts) : undefined,
    classified: classifiedKnown ? `${mapped!.toLocaleString("en-TZ")} of ${totalAccounts!.toLocaleString("en-TZ")} accounts classified` : undefined,
    balanced: totals === null ? undefined : outOfBalance
      ? `Debits and credits differ by ${formatCents(Math.abs(totals.differenceCents))}`
      : "Total debits equal total credits",
    complete: upload.processed_at ? "Processed" : undefined,
  };

  const steps: LedgerStep[] = base.map((s) => ({
    ...s,
    detail: details[s.key],
    state: reached[s.key] ? "done" : "pending",
  }));

  // Classification coverage is a real gate, not a footnote: unresolved accounts mean the step needs review.
  if (classifiedKnown && unresolved !== null && unresolved > 0) {
    const idx = steps.findIndex((s) => s.key === "classified");
    steps[idx].state = "attention";
    steps[idx].detail = `${unresolved.toLocaleString("en-TZ")} of ${totalAccounts!.toLocaleString("en-TZ")} accounts need a classification decision`;
  }
  // A recorded imbalance is a failure of the balance step itself.
  if (outOfBalance) steps[steps.findIndex((s) => s.key === "balanced")].state = "failed";

  if (isFailed) {
    const verdictStep = opts.failedCheckId ? STEP_FOR_CHECK[opts.failedCheckId] : undefined;
    const idx = verdictStep ? steps.findIndex((s) => s.key === verdictStep) : -1;
    if (idx >= 0) steps[idx].state = "failed";
    else if (!steps.some((s) => s.state === "failed")) {
      // No authoritative failing check (an engine error): the first step that did not complete is where it stopped.
      const firstOpen = steps.findIndex((s) => s.state !== "done");
      if (firstOpen >= 0) steps[firstOpen].state = "failed";
    }
  } else if (isProcessing) {
    const firstOpen = steps.findIndex((s) => s.state === "pending");
    if (firstOpen >= 0) steps[firstOpen].state = "running";
  }

  return steps;
}

const ICONS: Record<StepState, JSX.Element> = {
  done:    <Check className="w-3 h-3 text-success" />,
  failed:  <X className="w-3 h-3 text-destructive" />,
  running: <Loader2 className="w-3 h-3 text-primary animate-spin" />,
  pending: <Minus className="w-3 h-3 text-muted-foreground/40" />,
  attention: <AlertTriangle className="w-3 h-3 text-amber-600" />,
};

const STATE_LABEL: Record<StepState, string> = {
  done: "Done",
  failed: "Failed",
  running: "Running",
  pending: "Waiting",
  attention: "Needs review",
};

const STATE_TONE: Record<StepState, Tone> = {
  done: "done",
  failed: "bad",
  running: "active",
  pending: "muted",
  attention: "warn",
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function TrialBalanceProgressLedger({
  upload,
  failedCheckId = null,
}: {
  upload: WorkspaceUpload | null;
  /** The verdict's failing check (trialBalanceVerdict.ts), so the ledger blames the same step the verdict does. */
  failedCheckId?: string | null;
}) {
  const steps = deriveTrialBalanceSteps(upload, { failedCheckId });
  const doneCount = steps.filter((s) => s.state === "done").length;
  const failed = steps.some((s) => s.state === "failed");
  const running = steps.some((s) => s.state === "running");
  const attention = steps.some((s) => s.state === "attention");

  // Elapsed clock — an unbounded spinner is the single worst thing a financial
  // engine can show. The user always sees how long the run has been going.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const startedAt = upload?.uploaded_at ? new Date(upload.uploaded_at).getTime() : null;
  const elapsedMs = running && startedAt ? now - startedAt : null;
  const slow = elapsedMs !== null && elapsedMs > 120_000;

  const phase = failed ? "Failed" : doneCount === steps.length ? "Completed" : running ? "Processing" : "Uploaded";

  return (
    <section className="mb-10" aria-live="polite">
      <SurfaceCard>
      <SurfaceCardHeader
        label="Trial balance progress"
        meta={
          <>
            {phase} · {doneCount} of {steps.length}
            {elapsedMs !== null && <span> · {formatElapsed(elapsedMs)} elapsed</span>}
          </>
        }
      />

      {/* Thin progress rule — no bars, no chrome */}
      <div className="h-px w-full bg-border">
        <div
          className={`h-px transition-all duration-500 ${failed ? "bg-destructive" : attention ? "bg-amber-500" : doneCount === steps.length ? "bg-success" : "bg-primary"}`}
          style={{ width: `${(doneCount / steps.length) * 100}%` }}
        />
      </div>

      {slow && (
        <p className="px-5 pt-3 text-[12px] text-muted-foreground">
          Still running. You can leave this page — the run continues on the server and this
          ledger picks up exactly where it is when you come back.
        </p>
      )}


      <ol className="border-t border-border">
        {steps.map((s, i) => (
          <li key={s.key}>
            <LedgerRow
              highlight={s.state === "running"}
              step={String(i + 1).padStart(2, "0")}
              stepTone={STATE_TONE[s.state]}
              icon={ICONS[s.state]}
              title={s.label}
              titleMuted={s.state === "pending"}
              note={s.detail}
              status={<StatusMark tone={STATE_TONE[s.state]} label={STATE_LABEL[s.state]} />}
            />
          </li>
        ))}
      </ol>
      </SurfaceCard>
    </section>
  );
}
