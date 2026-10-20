/**
 * CurrentTrialBalanceCard — the one place Prepare Data states the trial balance's result: file, status, totals, one
 * plain-English reason and one failure-appropriate primary action. Everything it says comes from trialBalanceVerdict.ts
 * (the certification ledger), the same model the checks, the technical ledger and the Overview read.
 *
 * The status is a control: it takes the user straight to the checks that decided it.
 *
 * Two distinct destinations: the verdict's action (e.g. "Review account classifications", which opens and focuses the
 * account review) leads; "File options" is a secondary disclosure for the FILE itself — replace or remove it
 * (ManageTrialBalance) and open its upload history. It opens on arrival when the page was asked to show the file's
 * options (`?manage=source`).
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { AlertCircle, ArrowRight, ChevronDown, ChevronRight, History, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTotal, isOutOfBalance, type TrialBalanceVerdict } from "@/lib/workspace/trialBalanceVerdict";
import { FINDING_HEADING, FINDING_ORDER } from "@/lib/workspace/resultStatus";

export const TRIAL_BALANCE_CHECKS_ANCHOR = "trial-balance-checks";
/** The card's findings list: the ONE place each finding is stated (the checks list points here instead of repeating it). */
export const TRIAL_BALANCE_FINDINGS_ANCHOR = "trial-balance-findings";
const MAX_FIXES = 5;

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
};

/** What the card's button says. The account review is a review, so its action says so (the verdict keeps its kind). */
const CARD_ACTION_LABEL: Partial<Record<NonNullable<TrialBalanceVerdict["primaryAction"]>["kind"], string>> = {
  review_classifications: "Review account classifications",
};
const FILE_OPTIONS_LABEL = "File options";

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
  primaryEmphasis = "primary",
  fileOptionsOpen = false,
  onShowHistory,
  historyCount,
  findingAction,
  replaceRefusal = null,
  onDismissReplaceRefusal,
  resolution,
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
  /** Whether the verdict's action leads the page (reviewActionHierarchy). */
  primaryEmphasis?: "primary" | "secondary";
  /** Open "File options" on arrival (the page was asked to show the file's options). */
  fileOptionsOpen?: boolean;
  /** Opens and focuses the upload history section. Absent: no history control. */
  onShowHistory?: () => void;
  historyCount?: number;
  /** What can be done about one finding, rendered under it (null: nothing to offer). */
  findingAction?: (issue: TrialBalanceVerdict["issues"][number]) => ReactNode | null;
  /** A replacement file refused before upload, in words; shown persistently next to Replace (role="alert"). */
  replaceRefusal?: string | null;
  onDismissReplaceRefusal?: () => void;
  /** A recovery the server supports for this exact result (e.g. correcting the period's currency), shown above the
   *  actions. Absent: none. The page renders it only when the server says the recovery is possible or explains why not. */
  resolution?: ReactNode;
}) {
  const tone = TONE[verdict.tone];
  const [optionsOpen, setOptionsOpen] = useState(fileOptionsOpen);
  const optionsId = useId();
  const hasOptions = !!management || !!onShowHistory;
  // The refusal sits beside Replace: when Replace lives under File options, those options open with it.
  useEffect(() => { if (replaceRefusal && hasOptions) setOptionsOpen(true); }, [replaceRefusal, hasOptions]);
  const totals = verdict.totals;
  const outOfBalance = isOutOfBalance(totals);
  // Row-level corrections the server recorded; the one already stated as the reason is not repeated.
  const fixes = verdict.issues.filter((i) => i.message !== verdict.reason);
  // The first few of each kind, plus every finding that has an action here (a decision is never hidden in the details).
  const shownOf = (group: typeof fixes) => group.filter((i, n) => n < MAX_FIXES || (findingAction ? findingAction(i) !== null : false));
  const unit = totals?.currency ? ` (${totals.currency})` : "";
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
        {fixes.length > 0 && (
          <div id={TRIAL_BALANCE_FINDINGS_ANCHOR} className="mt-4 max-w-3xl space-y-4" data-testid="trial-balance-issues">
            {/* One group per kind, in order: blocking, needs confirmation, review (resultStatus.ts, §3.5). */}
            {FINDING_ORDER.map((kind) => {
              const group = fixes.filter((i) => i.kind === kind);
              if (group.length === 0) return null;
              return (
                <div key={kind} data-finding-kind={kind}>
                  <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{FINDING_HEADING[kind]}</p>
                  <ul className="mt-2 space-y-2">
                    {shownOf(group).map((i) => (
                      <li key={`${i.code}-${i.subject ?? ""}-${i.rows.join(",")}`} className={`border-l-2 pl-3 text-[13px] leading-relaxed text-foreground ${kind === "blocking" ? "border-destructive/60" : "border-amber-500/70"}`} data-code={i.code}>
                        {i.message}
                        {findingAction?.(i)}
                      </li>
                    ))}
                  </ul>
                  {group.length > shownOf(group).length && (
                    <p className="mt-2 text-[12px] text-muted-foreground">and {group.length - shownOf(group).length} more — listed under Technical processing details.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {totals && (
        <dl className="grid grid-cols-1 border-t border-border sm:grid-cols-3" data-testid="trial-balance-totals">
          {[
            [`Total debits${unit}`, formatTotal(totals, totals.debitCents), false],
            [`Total credits${unit}`, formatTotal(totals, totals.creditCents), false],
            ["Difference", formatTotal(totals, Math.abs(totals.differenceCents)), outOfBalance],
          ].map(([label, value, bad], i) => (
            <div key={label as string} className={`min-w-0 px-5 py-4 sm:px-7 ${i > 0 ? "border-t border-border sm:border-l sm:border-t-0" : ""}`}>
              <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
              <dd className={`mt-1 break-all font-semibold tabular-nums text-[17px] sm:text-lg ${bad ? "text-destructive" : "text-foreground"}`}>{value}</dd>
              {label === "Difference" && verdict.balanceStatement && (
                <dd className="mt-0.5 text-[12px] text-muted-foreground" data-testid="trial-balance-balance-statement">{verdict.balanceStatement}</dd>
              )}
            </div>
          ))}
        </dl>
      )}

      {resolution && (
        <div className="border-t border-border px-5 py-4 sm:px-7" data-testid="trial-balance-resolution">{resolution}</div>
      )}

      {(verdict.primaryAction || hasOptions || replaceRefusal) && (
        <div className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:px-7">
          {verdict.primaryAction && (
            <Button
              size="lg"
              variant={primaryEmphasis === "primary" ? "default" : "outline"}
              disabled={busy}
              onClick={() => onPrimary(verdict.primaryAction!.kind)}
              data-testid="trial-balance-primary-action"
              data-action-emphasis={primaryEmphasis}
              className="h-auto min-h-11 w-full whitespace-normal rounded-none px-5 py-2.5 text-left text-[14px] font-semibold leading-snug shadow-none sm:w-auto"
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : ACTION_ICON[verdict.primaryAction.kind]}
              {CARD_ACTION_LABEL[verdict.primaryAction.kind] ?? verdict.primaryAction.label}
            </Button>
          )}
          {hasOptions && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOptionsOpen((o) => !o)}
              aria-expanded={optionsOpen}
              aria-controls={optionsId}
              data-testid="trial-balance-file-options"
              className="h-11 w-full justify-between rounded-none px-3 text-[13px] font-medium text-foreground sm:w-auto sm:justify-center"
            >
              {FILE_OPTIONS_LABEL}
              <ChevronDown className={`ml-2 h-4 w-4 text-muted-foreground transition-transform ${optionsOpen ? "rotate-180" : ""}`} aria-hidden="true" />
            </Button>
          )}
          {hasOptions && optionsOpen && (
            <div id={optionsId} role="group" aria-label={FILE_OPTIONS_LABEL} className="flex basis-full flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:items-center" data-testid="trial-balance-file-options-panel">
              {management}
              {onShowHistory && (
                <Button type="button" variant="outline" size="sm" onClick={onShowHistory} className="h-9 rounded-none text-[13px] shadow-none" data-testid="trial-balance-show-history">
                  <History className="mr-2 h-4 w-4" aria-hidden="true" />
                  Upload history{typeof historyCount === "number" ? ` · ${historyCount}` : ""}
                </Button>
              )}
            </div>
          )}
          {replaceRefusal && (
            <div role="alert" className="flex basis-full items-start gap-2 border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[13px] text-foreground" data-testid="trial-balance-replace-refusal">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <p className="min-w-0 flex-1 break-words">{replaceRefusal}</p>
              {onDismissReplaceRefusal && (
                <button type="button" onClick={onDismissReplaceRefusal} aria-label="Dismiss this message"
                  className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="trial-balance-replace-refusal-dismiss">
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
