/**
 * CurrentTrialBalanceCard — the one place Prepare Data states the trial balance's result: file, status, totals, one
 * plain-English reason and one failure-appropriate primary action. Everything it says comes from trialBalanceVerdict.ts
 * (the certification ledger), the same model the checks, the technical ledger and the Overview read.
 *
 * The status is a control: it takes the user straight to the checks that decided it.
 */

import type { ReactNode } from "react";
import { ArrowRight, ChevronRight, Loader2, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCents, isOutOfBalance, type TrialBalanceVerdict } from "@/lib/workspace/trialBalanceVerdict";

export const TRIAL_BALANCE_CHECKS_ANCHOR = "trial-balance-checks";

const TONE: Record<TrialBalanceVerdict["tone"], { badge: string; rule: string }> = {
  danger: { badge: "border-destructive/40 bg-destructive/5 text-destructive", rule: "bg-destructive" },
  warning: { badge: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", rule: "bg-amber-500" },
  success: { badge: "border-success/40 bg-success/10 text-success", rule: "bg-success" },
  neutral: { badge: "border-border bg-muted/40 text-muted-foreground", rule: "bg-border" },
};

const ACTION_ICON: Record<NonNullable<TrialBalanceVerdict["primaryAction"]>["kind"], JSX.Element> = {
  replace: <Upload className="mr-2 h-4 w-4" />,
  retry: <RefreshCw className="mr-2 h-4 w-4" />,
  review_classifications: <ArrowRight className="mr-2 h-4 w-4" />,
  verify_evidence: <ShieldCheck className="mr-2 h-4 w-4" />,
  continue: <ArrowRight className="mr-2 h-4 w-4" />,
};

function uploadedLine(uploadedAt: string, fileSize: number): string {
  const d = new Date(uploadedAt);
  const when = Number.isNaN(d.getTime()) ? null : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const size = Number.isFinite(fileSize) && fileSize > 0 ? (fileSize < 1024 * 1024 ? `${Math.max(1, Math.round(fileSize / 1024))} KB` : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`) : null;
  return [when ? `Uploaded ${when}` : null, size].filter(Boolean).join(" · ");
}

export function CurrentTrialBalanceCard({
  fileName,
  uploadedAt,
  fileSize,
  verdict,
  busy = false,
  onPrimary,
  management,
}: {
  fileName: string;
  uploadedAt: string;
  fileSize: number;
  verdict: TrialBalanceVerdict;
  /** A primary action is in flight (replace, retry). */
  busy?: boolean;
  onPrimary: (kind: NonNullable<TrialBalanceVerdict["primaryAction"]>["kind"]) => void;
  /** Replace / Remove as quiet secondary actions (ManageTrialBalance, inline variant). */
  management?: ReactNode;
}) {
  const tone = TONE[verdict.tone];
  const totals = verdict.totals;
  const outOfBalance = isOutOfBalance(totals);
  const goToChecks = () => {
    const el = document.getElementById(TRIAL_BALANCE_CHECKS_ANCHOR);
    el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    (el?.querySelector("h2") as HTMLElement | null)?.focus?.({ preventScroll: true });
  };

  return (
    <section
      aria-labelledby="current-trial-balance-title"
      data-testid="current-trial-balance"
      data-status={verdict.status}
      className="relative overflow-hidden border border-border bg-card"
    >
      <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${tone.rule}`} />
      <div className="px-5 pb-5 pt-5 sm:px-7 sm:pt-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Current trial balance</p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 id="current-trial-balance-title" className="break-all text-lg font-semibold leading-snug text-foreground sm:text-xl" title={fileName}>
              {fileName}
            </h2>
            <p className="mt-1 text-[12px] text-muted-foreground">{uploadedLine(uploadedAt, fileSize)}</p>
          </div>
          <button
            type="button"
            onClick={goToChecks}
            aria-controls={TRIAL_BALANCE_CHECKS_ANCHOR}
            data-testid="trial-balance-status"
            className={`inline-flex shrink-0 items-center gap-1.5 self-start border px-3 py-1.5 text-[13px] font-semibold uppercase tracking-[0.08em] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tone.badge}`}
          >
            {verdict.status === "processing" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {verdict.statusLabel}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">— see the checks</span>
          </button>
        </div>
        <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-foreground" data-testid="trial-balance-reason">{verdict.reason}</p>
      </div>

      {totals && (
        <dl className="grid grid-cols-1 border-t border-border sm:grid-cols-3" data-testid="trial-balance-totals">
          {[
            ["Total debits", formatCents(totals.debitCents), false],
            ["Total credits", formatCents(totals.creditCents), false],
            ["Difference", formatCents(Math.abs(totals.differenceCents)), outOfBalance],
          ].map(([label, value, bad], i) => (
            <div key={label as string} className={`min-w-0 px-5 py-4 sm:px-7 ${i > 0 ? "border-t border-border sm:border-l sm:border-t-0" : ""}`}>
              <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
              <dd className={`mt-1 break-all font-semibold tabular-nums text-[17px] sm:text-lg ${bad ? "text-destructive" : "text-foreground"}`}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {(verdict.primaryAction || management) && (
        <div className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:px-7">
          {verdict.primaryAction && (
            <Button
              size="lg"
              disabled={busy}
              onClick={() => onPrimary(verdict.primaryAction!.kind)}
              data-testid="trial-balance-primary-action"
              className="h-auto min-h-11 w-full whitespace-normal rounded-none px-5 py-2.5 text-left text-[14px] font-semibold leading-snug shadow-none sm:w-auto"
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : ACTION_ICON[verdict.primaryAction.kind]}
              {verdict.primaryAction.label}
            </Button>
          )}
          {management}
        </div>
      )}
    </section>
  );
}
