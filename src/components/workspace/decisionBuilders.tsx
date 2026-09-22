/**
 * decisionBuilders — the two functions that turn real engine output into a `Decision` for
 * <DecisionCard> to render: `buildClassificationDecision` (classificationPresentation.ts's 7
 * states) and `buildNextActionDecision` (deriveWorkspaceState.ts's nextAction). Kept in their own
 * module, separate from DecisionCard.tsx's component export, so this file mixes no component with
 * non-component exports — DecisionCard.tsx exports only the component, this file exports only
 * functions/types, and Fast Refresh boundaries stay clean on both sides.
 */

import { ArrowRight, RefreshCw } from "lucide-react";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { ClassificationPresentation } from "@/lib/workspace/classificationPresentation";
import type { WorkspaceState } from "@/lib/workspace/types";
import type { Decision } from "./DecisionCard";

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

/**
 * Maps `workspaceState.nextAction` (the real, pure output of deriveWorkspaceState() — the SAME
 * single authority WorkspaceOverview.tsx's own PATH-6B-certification-blocked branch and its generic
 * "else" branch both read) directly to the `Decision` this card renders. Used by the internal
 * workflow-states acceptance page (src/pages/internal/WorkspaceStatesAcceptance.tsx) to demonstrate
 * every one of deriveWorkspaceState's 11 paths through the real engine and the real card, without a
 * live workspace or a mandate/localStorage dependency — WorkspaceOverview's own generic branch
 * additionally consults the mandate-projected active stage and a remembered outcome to refine the
 * eyebrow and button destination; this simpler builder reads nextAction.mission for the eyebrow
 * instead, so it is not a byte-for-byte reproduction of that refinement, but headline, detail and
 * the button's label/href/blocked state are unmodified nextAction fields in every case.
 */
export function buildNextActionDecision(workspaceState: WorkspaceState): Decision {
  const { nextAction } = workspaceState;
  const isCertificationBlocked = nextAction.id === "fix-certification-failure" || nextAction.id === "await-certification";

  if (isCertificationBlocked) {
    return {
      eyebrow: STAGE_CONFIGS.prepare.label,
      headline: nextAction.label,
      detail: nextAction.description,
      button: { label: nextAction.label, href: nextAction.href, icon: <ArrowRight className="w-4 h-4" /> },
      tone: "warn",
      offersFileReplacement: true,
    };
  }

  return {
    eyebrow: STAGE_CONFIGS[nextAction.mission].label,
    headline: nextAction.description,
    detail: nextAction.blocker ?? undefined,
    button: { label: nextAction.label, href: nextAction.href, disabled: nextAction.blocked, icon: <ArrowRight className="w-4 h-4" /> },
    tone: nextAction.blocked ? "muted" : "primary",
  };
}
