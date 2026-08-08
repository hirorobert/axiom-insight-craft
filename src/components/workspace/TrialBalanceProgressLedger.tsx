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

/** Pure derivation — exported for reuse/testing. */
export function deriveTrialBalanceSteps(upload: WorkspaceUpload | null): LedgerStep[] {
  const base: Array<{ key: string; label: string }> = [
    { key: "received",   label: "File received" },
    { key: "queued",     label: "Queued for processing" },
    { key: "parsed",     label: "Workbook parsed" },
    { key: "classified", label: "Accounts classified" },
    { key: "balanced",   label: "Trial balance balance check" },
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
    | { summary?: Record<string, unknown>; statements?: unknown; errors?: unknown[] }
    | null;
  const summary = pr?.summary ?? null;
  const errors = Array.isArray(pr?.errors) ? pr!.errors : [];

  const totalAccounts =
    summary && typeof summary.total_accounts === "number" ? summary.total_accounts : null;
  const autoClassified =
    summary && typeof summary.auto_classified === "number" ? summary.auto_classified : null;

  const errorCodes = errors
    .map((e) => (e && typeof e === "object" ? String((e as { code?: unknown }).code ?? "") : ""))
    .filter(Boolean);
  const imbalance = errorCodes.some(
    (c) => c.includes("IMBALANCE") || c.includes("BALANCE_SHEET_EQUATION"),
  );

  // Per-step completion signals (null = not yet evidenced).
  const reached: Record<string, boolean> = {
    received: true,
    queued: status !== "pending",
    parsed: totalAccounts !== null,
    classified: autoClassified !== null,
    balanced: totalAccounts !== null && !imbalance,
    statements: !!pr?.statements,
    complete: isDone,
  };

  const details: Record<string, string | undefined> = {
    received: upload.file_name,
    parsed: totalAccounts !== null ? pluralAccounts(totalAccounts) : undefined,
    classified:
      autoClassified !== null && totalAccounts !== null
        ? `${autoClassified} of ${totalAccounts} auto-classified`
        : undefined,
    balanced: imbalance ? "Balance sheet equation did not hold" : undefined,
    complete: upload.processed_at ? "Processed" : undefined,
  };

  const steps: LedgerStep[] = base.map((s) => ({
    ...s,
    detail: details[s.key],
    state: reached[s.key] ? "done" : "pending",
  }));

  // Classification coverage is a real gate, not a footnote. If the classifier
  // left accounts unresolved, the step is NOT "Done" — every downstream
  // statement built on an unmapped account is wrong at source.
  if (autoClassified !== null && totalAccounts !== null && autoClassified < totalAccounts) {
    const unresolved = totalAccounts - autoClassified;
    const idx = steps.findIndex((s) => s.key === "classified");
    if (idx >= 0) {
      steps[idx].state = "attention";
      steps[idx].detail = `${unresolved.toLocaleString("en-TZ")} of ${totalAccounts.toLocaleString("en-TZ")} accounts still need a mapping decision`;
    }
  }

  // First unreached step carries the live marker.
  const firstOpen = steps.findIndex((s) => s.state !== "done");
  if (firstOpen >= 0) {
    if (isFailed) steps[firstOpen].state = "failed";
    else if (isProcessing && steps[firstOpen].state === "pending") steps[firstOpen].state = "running";
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
  lastRefreshedAt,
}: {
  upload: WorkspaceUpload | null;
  lastRefreshedAt?: Date | null;
}) {
  const steps = deriveTrialBalanceSteps(upload);
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

      {attention && (
        <p className="px-5 pt-3 pb-1 text-[12px] text-amber-600">
          Some accounts have no mapping decision yet. Resolve them in Prepare Data before the
          statements are trusted — an unmapped account is a wrong statement, not a small gap.
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
