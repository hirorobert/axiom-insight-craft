/**
 * TrialBalancePreflight — the pre-flight gate the eye lands on first.
 *
 * One verdict, one sentence, five checks. Nothing competes with the verdict.
 * Read-only projection of computePreflight(). No writes.
 */

import { Check, X, AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { computePreflight, type PreflightCheckState } from "@/lib/workspace/computePreflight";

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload: any | null;
  /** Where "Resolve" should take the user, when there is something to resolve. */
  resolveHref?: string;
}

const VERDICT_LABEL = {
  certified: "Checks passed",
  review: "Needs review",
  blocked: "Checks failed",
  pending: "Checking",
} as const;

function StateGlyph({ state }: { state: PreflightCheckState }) {
  if (state === "passed") return <Check className="h-3.5 w-3.5 text-success" strokeWidth={3} />;
  if (state === "failed") return <X className="h-3.5 w-3.5 text-destructive" strokeWidth={3} />;
  if (state === "review") return <AlertTriangle className="h-3.5 w-3.5 text-gold" strokeWidth={2.5} />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" strokeWidth={2.5} />;
}

export function TrialBalancePreflight({ upload, resolveHref }: Props) {
  const result = computePreflight(
    upload
      ? {
          status: upload.status,
          isValid: upload.is_valid,
          processedAt: upload.processed_at,
          processingResult: upload.processing_result,
          validationReport: upload.validation_report,
          accountingErrors: upload.accounting_errors,
        }
      : null,
  );

  const accentText =
    result.verdict === "certified"
      ? "text-success"
      : result.verdict === "blocked"
        ? "text-destructive"
        : result.verdict === "review"
          ? "text-gold"
          : "text-muted-foreground";

  return (
    <section
      data-testid="tb-preflight"
      data-verdict={result.verdict}
      className="border border-border bg-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Pre-flight status
          </h2>
        </div>
        <span className={`font-mono text-[11px] uppercase tracking-[0.18em] ${accentText}`}>
          {VERDICT_LABEL[result.verdict]} · {result.passedCount}/{result.totalCount}
        </span>
      </header>

      <div className="px-6 py-5">
        <p className="text-base font-semibold tracking-tight text-foreground">{result.headline}</p>
        {result.blocker && (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{result.blocker}</p>
        )}

        {result.checks.length > 0 && (
          <ul className="mt-5 divide-y divide-border border-t border-border">
            {result.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-3 py-2.5">
                <span className="mt-0.5 shrink-0">
                  <StateGlyph state={c.state} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{c.label}</span>
                  <span className="block text-[12px] leading-relaxed text-muted-foreground">
                    {c.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {resolveHref && (result.verdict === "review" || result.verdict === "blocked") && (
          <Link
            to={resolveHref}
            className="mt-5 inline-flex text-sm text-primary underline underline-offset-4 hover:text-primary/80"
          >
            Resolve in this trial balance
          </Link>
        )}
      </div>
    </section>
  );
}
