/**
 * TrialBalancePreflight — the pre-flight gate the eye lands on first.
 *
 * One verdict, one sentence, five checks. Nothing competes with the verdict.
 * Read-only projection of computePreflight(). No writes.
 */

import { Check, X, AlertTriangle, Clock3, ShieldCheck, ArrowRight, Info, CircleHelp } from "lucide-react";
import { Link } from "react-router-dom";
import { computePreflight, type PreflightResult } from "@/lib/workspace/computePreflight";
import { presentReadiness, type CheckTone, type PresentedCheck } from "@/lib/workspace/certificationCheckPresentation";
import type { TbCertificationRow } from "@/lib/workspace/computeCertificationReadiness";

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload: any | null;
  /** Where "Resolve" should take the user, when there is something to resolve. */
  resolveHref?: string;
  /**
   * When provided, supersedes the legacy computePreflight(upload) five-check
   * projection entirely — used by PrepareWorkspace to show the six-layer
   * authoritative (tb_certifications) readiness instead of the mutable
   * processing_result projection. StatementsWorkspace does not pass this,
   * so its call site is unaffected.
   */
  readiness?: PreflightResult;
  /**
   * The certification row the readiness layers were drawn from (certificationRowForDisplay). Presentation only: its
   * structured layer and severity decide how rows are drawn; message text is never read as state.
   */
  certificationRow?: TbCertificationRow | null;
}

const VERDICT_LABEL = {
  certified: "Checks passed",
  review: "Needs review",
  blocked: "Checks failed",
  pending: "Checking",
  stale: "Out of date",
  unknown: "Unverified",
  superseded: "Not current",
} as const;

/**
 * Presentation-layer wording for the verdict sentence. The domain function
 * keeps its own semantic headline; user-facing terminology is translated here
 * only, keyed off the unchanged verdict value.
 */
const VERDICT_HEADLINE: Partial<Record<keyof typeof VERDICT_LABEL, string>> = {
  blocked: "Checks failed — the trial balance does not hold",
};

// Only "passed" is drawn as a success. Informational assessments and anything unavailable are neutral.
function StateGlyph({ tone }: { tone: CheckTone }) {
  if (tone === "passed") return <Check className="h-3.5 w-3.5 text-success" strokeWidth={3} />;
  if (tone === "failed") return <X className="h-3.5 w-3.5 text-destructive" strokeWidth={3} />;
  if (tone === "review") return <AlertTriangle className="h-3.5 w-3.5 text-gold" strokeWidth={2.5} />;
  if (tone === "informational") return <Info className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2.5} />;
  if (tone === "unavailable") return <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2.5} />;
  return <Clock3 className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2.5} />;
}

function CheckRow({ check }: { check: PresentedCheck }) {
  return (
    <li data-testid={`tb-check-${check.id}`} data-tone={check.tone} className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 shrink-0">
        <StateGlyph tone={check.tone} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{check.label}</span>
        <span className="block text-[12px] leading-relaxed text-muted-foreground">{check.text}</span>
      </span>
    </li>
  );
}

export function TrialBalancePreflight({ upload, resolveHref, readiness, certificationRow = null }: Props) {
  const result =
    readiness ??
    computePreflight(
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
        : result.verdict === "review" || result.verdict === "stale" || result.verdict === "superseded"
          ? "text-gold"
          : "text-muted-foreground";

  const displayHeadline = VERDICT_HEADLINE[result.verdict] ?? result.headline;
  // Six-layer readiness: four REQUIRED checks are counted; supporting evidence and the prior-period signal are shown
  // separately as informational assessments and never counted as passed. The legacy five-check projection is unchanged.
  const presented = presentReadiness(result, VERDICT_LABEL[result.verdict], certificationRow);

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
        <span data-testid="tb-preflight-count" className={`font-mono text-[11px] uppercase tracking-[0.18em] ${accentText}`}>
          {presented.countLabel}
        </span>
      </header>

      <div className="px-6 py-5">
        <p className="text-base font-semibold tracking-tight text-foreground">{displayHeadline}</p>
        {result.blocker && (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{result.blocker}</p>
        )}

        {presented.required.length > 0 && (
          <ul data-testid="tb-required-checks" className="mt-5 divide-y divide-border border-t border-border">
            {presented.required.map((c) => <CheckRow key={c.id} check={c} />)}
          </ul>
        )}

        {presented.informational.length > 0 && (
          <div className="mt-5">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Informational assessments · not counted
            </h3>
            <ul data-testid="tb-informational-checks" className="mt-2 divide-y divide-border border-t border-border">
              {presented.informational.map((c) => <CheckRow key={c.id} check={c} />)}
            </ul>
          </div>
        )}

        {resolveHref && (result.verdict === "review" || result.verdict === "blocked") && (
          <Link
            to={resolveHref}
            data-testid="tb-preflight-resolve"
            className="mt-5 inline-flex items-center gap-2 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Resolve now
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    </section>
  );
}
