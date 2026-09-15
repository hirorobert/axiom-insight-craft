/**
 * resolveNextActionDestination — pure, no side effects.
 *
 * The remembered public-landing outcome (src/lib/product/outcomes.ts) is a
 * UX routing preference only — it never grants or infers a mandate/
 * capability (mandate.ts's own invariant: "deliberately NO default
 * selection"). This function does not decide whether the "statements"
 * stage is in scope; it only decides WHICH screen within an
 * already-in-scope "statements" stage the dominant CTA should point to.
 *
 * Used by WorkspaceOverview.tsx so the trial-balance-driven engine state
 * (deriveWorkspaceState.ts) remains completely untouched by outcome/intent
 * concerns.
 */

import type { OutcomeRouteIntent } from "@/lib/product/outcomes";
import type { WorkspaceMission } from "./types";

export interface NextActionDestinationInput {
  activeSlug: WorkspaceMission | null;
  basePath: string;
  nextActionHref: string;
  nextActionLabel: string;
  routeIntent: OutcomeRouteIntent | undefined;
}

export interface NextActionDestination {
  href: string;
  label: string;
}

export function resolveNextActionDestination(
  input: NextActionDestinationInput,
): NextActionDestination {
  const { activeSlug, basePath, nextActionHref, nextActionLabel, routeIntent } = input;

  const wantsDocumentReview =
    activeSlug === "statements" &&
    routeIntent === "review-existing-statements" &&
    nextActionHref === `${basePath}/statements`;

  if (!wantsDocumentReview) {
    return { href: nextActionHref, label: nextActionLabel };
  }

  return { href: `${basePath}/statements/review`, label: "Review statements" };
}
