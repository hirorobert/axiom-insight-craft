/**
 * DecisionCard — the ONE rendering of WorkspaceOverview's "current decision" surface: an eyebrow, a headline, an
 * optional detail line, a single dominant CTA, and an optional quiet file-replacement escape.
 *
 * Extracted verbatim from WorkspaceOverview.tsx (no markup or class name changed) so there is exactly one place that
 * turns a `Decision` into DOM — the production screen and the internal acceptance pages
 * (ClassificationStatesAcceptance.tsx, WorkspaceStatesAcceptance.tsx) all render through this same component.
 * Presentation only: no data fetching, no routing decisions, no side effects.
 *
 * The functions that BUILD a `Decision` (`buildClassificationDecision`, `buildNextActionDecision`) live in the
 * sibling decisionBuilders.tsx, not here — this file exports only the component, so Fast Refresh boundaries stay
 * clean and this stays the one place a `Decision` becomes DOM without also being the one place a `Decision` is made.
 */

import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";

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
