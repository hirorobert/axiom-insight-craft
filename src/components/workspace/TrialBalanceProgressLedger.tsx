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

import { Check, X, Loader2, Minus } from "lucide-react";
import type { WorkspaceUpload } from "@/hooks/useWorkspaceData";

type StepState = "pending" | "running" | "done" | "failed";

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

  // First unreached step carries the live marker.
  const firstOpen = steps.findIndex((s) => s.state !== "done");
  if (firstOpen >= 0) {
    if (isFailed) steps[firstOpen].state = "failed";
    else if (isProcessing) steps[firstOpen].state = "running";
  }

  return steps;
}

const ICONS: Record<StepState, JSX.Element> = {
  done:    <Check className="w-3 h-3 text-success" />,
  failed:  <X className="w-3 h-3 text-destructive" />,
  running: <Loader2 className="w-3 h-3 text-primary animate-spin" />,
  pending: <Minus className="w-3 h-3 text-muted-foreground/40" />,
};

const STATE_LABEL: Record<StepState, string> = {
  done: "Done",
  failed: "Failed",
  running: "Running",
  pending: "Waiting",
};

const STATE_TEXT: Record<StepState, string> = {
  done: "text-success",
  failed: "text-destructive",
  running: "text-primary",
  pending: "text-muted-foreground/60",
};

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

  const phase = failed ? "Failed" : doneCount === steps.length ? "Completed" : running ? "Processing" : "Uploaded";

  return (
    <section className="mb-14" aria-live="polite">
      <div className="flex items-baseline justify-between mb-5">
        <p className="text-[10px] font-semibold text-muted-foreground tracking-[0.22em] uppercase">
          Trial balance progress
        </p>
        <p className="text-[11px] text-muted-foreground/70 tabular-nums tracking-wide">
          {phase} · {doneCount} of {steps.length}
          {lastRefreshedAt && <span className="text-muted-foreground/50"> · live</span>}
        </p>
      </div>

      {/* Thin progress rule — no bars, no chrome */}
      <div className="h-px w-full bg-border mb-1">
        <div
          className={`h-px transition-all duration-500 ${failed ? "bg-destructive" : doneCount === steps.length ? "bg-success" : "bg-primary"}`}
          style={{ width: `${(doneCount / steps.length) * 100}%` }}
        />
      </div>

      <ol className="border-t border-border">
        {steps.map((s, i) => (
          <li key={s.key}>
            <div
              className={[
                "grid grid-cols-[3.5rem_1.25rem_1fr_auto] items-center gap-4 py-3 border-b border-border transition-colors",
                s.state === "running" ? "bg-primary/[0.03]" : "",
              ].join(" ")}
            >
              <span
                className={[
                  "text-[11px] font-mono tabular-nums pl-1",
                  s.state === "done" ? "text-success"
                    : s.state === "running" ? "text-primary font-semibold"
                    : s.state === "failed" ? "text-destructive font-semibold"
                    : "text-muted-foreground/50",
                ].join(" ")}
              >
                {String(i + 1).padStart(2, "0")}
              </span>

              <span className="inline-flex items-center justify-center">{ICONS[s.state]}</span>

              <div className="min-w-0">
                <p
                  className={[
                    "text-[14px] leading-tight tracking-tight",
                    s.state === "pending" ? "text-muted-foreground" : "text-foreground",
                  ].join(" ")}
                >
                  {s.label}
                </p>
                {s.detail && (
                  <p className="mt-0.5 text-[12px] text-muted-foreground/70 truncate">{s.detail}</p>
                )}
              </div>

              <span className={`text-[12px] whitespace-nowrap ${STATE_TEXT[s.state]}`}>
                {STATE_LABEL[s.state]}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
