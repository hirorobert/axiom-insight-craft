/**
 * DecisionCard — the ONE rendering of WorkspaceOverview's "current decision" surface: an eyebrow, a headline, an
 * optional detail line, a single dominant CTA, and an optional quiet file-replacement escape.
 *
 * Extracted verbatim from WorkspaceOverview.tsx (no markup or class name changed) so there is exactly one place that
 * turns a `Decision` into DOM — the production screen and the internal classification-states acceptance page
 * (src/pages/internal/ClassificationStatesAcceptance.tsx) both render through this same component. Presentation only:
 * no data fetching, no routing decisions, no side effects.
 *
 * `buildClassificationDecision` is the second half of the same "one semantic authority" discipline
 * classificationPresentation.ts established: it is the ONLY place that turns a `ClassificationPresentation` (the
 * pure, exhaustively-typed result of deriveClassificationPresentation()) into the eyebrow/headline/detail/button
 * shape this card renders, for every one of the 7 classification states. WorkspaceOverview and the acceptance page
 * both call it — neither re-derives or duplicates this mapping.
 */

import { Link } from "react-router-dom";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { ClassificationPresentation } from "@/lib/workspace/classificationPresentation";

export interface Decision {
  readonly eyebrow: string;
  readonly headline: string;
  readonly detail?: string;
  readonly button: {
    readonly label: string;
    readonly href?: string;
    readonly onClick?: () => void;
    readonly icon: React.ReactNode;
    readonly disabled?: boolean;
  };
  readonly tone: "primary" | "warn" | "muted";
  /** Set only by decisions about a file the preparer may need to swap out (failed processing, accounts needing review). */
  readonly offersFileReplacement?: boolean;
}

export function DecisionCard({ decision, manageUploadHref }: { decision: Decision; manageUploadHref: string }) {
  const eyebrowTone = decision.tone === "warn" ? "text-destructive" : decision.tone === "muted" ? "text-muted-foreground" : "text-primary";

  return (
    <SurfaceCard className="px-5 py-8 sm:px-8 sm:py-10">
      <p className={`text-[10px] font-semibold uppercase tracking-[0.22em] mb-5 ${eyebrowTone}`}>{decision.eyebrow}</p>
      <h2 className="text-2xl sm:text-[2rem] font-semibold tracking-tight text-foreground leading-[1.2] max-w-xl">{decision.headline}</h2>
      {decision.detail && <p className="mt-4 text-[14px] text-muted-foreground leading-relaxed max-w-xl">{decision.detail}</p>}

      <div className="mt-8">
        {decision.button.href && !decision.button.disabled ? (
          <Button asChild size="lg" data-testid="primary-cta" variant={decision.tone === "muted" ? "outline" : "default"} className="h-12 w-full sm:w-auto px-6 text-[14px] font-semibold rounded-none shadow-none">
            <Link to={decision.button.href}>
              {decision.button.icon}
              <span className="mx-2">{decision.button.label}</span>
            </Link>
          </Button>
        ) : (
          <Button
            onClick={decision.button.onClick}
            disabled={decision.button.disabled}
            size="lg"
            data-testid="primary-cta"
            variant={decision.tone === "warn" ? "destructive" : "default"}
            className="h-12 w-full sm:w-auto px-6 text-[14px] font-semibold rounded-none shadow-none"
          >
            {decision.button.icon}
            <span className="mx-2">{decision.button.label}</span>
          </Button>
        )}
      </div>

      {/* Quiet escape: replacing or removing the upload is Prepare Data's existing behaviour, not a second implementation. */}
      {decision.offersFileReplacement && (
        <p className="mt-6 border-t border-border pt-5 text-[12px] text-muted-foreground" data-testid="replace-file-escape">
          Need to replace this file?{" "}
          <Link to={manageUploadHref} className="underline underline-offset-4 hover:text-foreground">
            Upload a replacement or remove this upload in Prepare Data <span aria-hidden="true">→</span>
          </Link>
        </p>
      )}
    </SurfaceCard>
  );
}

export interface ClassificationDecisionOptions {
  readonly retrying: boolean;
  readonly onRetry: () => void;
  /** The existing Prepare Data route for this workspace (`${basePath}/prepare`). */
  readonly prepareHref: string;
  /** The existing Prepare Data review route for the active upload (buildPrepareReviewRoute(...)). */
  readonly reviewHref: string;
}

const num = (n: number) => n.toLocaleString("en-US");

/**
 * Maps a `ClassificationPresentation` (the real, pure output of deriveClassificationPresentation()) to the `Decision`
 * this card renders — the exact mapping WorkspaceOverview.tsx uses for its isFailed / isProcessing / isInconsistent /
 * needsReview / !prepareDone branches. Exhaustive over ClassificationState: every one of the 7 states produces a
 * Decision, so this function alone is enough to demonstrate the full state space without a live workspace.
 */
export function buildClassificationDecision(classification: ClassificationPresentation, opts: ClassificationDecisionOptions): Decision {
  const eyebrow = STAGE_CONFIGS.prepare.label;

  switch (classification.state) {
    case "FAILED":
      return {
        eyebrow,
        headline: classification.headline,
        detail: classification.detail,
        button: {
          label: opts.retrying ? "Retrying…" : "Retry processing",
          onClick: opts.onRetry,
          disabled: opts.retrying,
          icon: <RefreshCw className={`w-4 h-4 ${opts.retrying ? "animate-spin" : ""}`} />,
        },
        tone: "warn",
        offersFileReplacement: true,
      };

    case "PROCESSING":
      return {
        eyebrow,
        headline: classification.headline,
        detail: classification.detail,
        button: { label: "Open Prepare Data", href: opts.prepareHref, icon: <ArrowRight className="w-4 h-4" /> },
        tone: "muted",
      };

    case "INCONSISTENT":
      // Impossible or self-contradictory values (see classificationPresentation.ts) — fail closed. Never guessed or
      // silently normalised, and never presented as a review item, since the review screen reads the same corrupt data.
      return {
        eyebrow,
        headline: classification.headline,
        detail: classification.detail,
        button: { label: "Open Prepare Data", href: opts.prepareHref, icon: <ArrowRight className="w-4 h-4" /> },
        tone: "warn",
        offersFileReplacement: true,
      };

    case "COMPLETE_WITH_REVIEW":
    case "PARTIAL": {
      // classification.counts is guaranteed non-null for these two states.
      const reviewCount = classification.counts?.reviewRequired ?? 0;
      return {
        eyebrow,
        headline: classification.headline,
        detail: classification.detail,
        button: { label: `Review ${num(reviewCount)} ${reviewCount === 1 ? "account" : "accounts"}`, href: opts.reviewHref, icon: <ArrowRight className="w-4 h-4" /> },
        tone: "primary",
        offersFileReplacement: true,
      };
    }

    case "COMPLETE_NO_REVIEW":
    case "NOT_COMPUTED":
      // Surfaces the classification result immediately when it is authoritatively available (COMPLETE_NO_REVIEW).
      // NOT_COMPUTED falls back to the plain "later stages open" line — never a fabricated count, and never a claim
      // that this stage is finished (prepareDone governs that separately, outside classification's own domain).
      return {
        eyebrow,
        headline: "Finish preparing the trial balance.",
        detail: classification.state === "COMPLETE_NO_REVIEW" ? classification.headline : "Later stages open as each one passes.",
        button: { label: "Open Prepare Data", href: opts.prepareHref, icon: <ArrowRight className="w-4 h-4" /> },
        tone: "primary",
      };
  }
}
