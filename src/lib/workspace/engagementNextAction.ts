/**
 * engagementNextAction — what an engagement's own button on the account home says and opens.
 *
 * Pure, from the engagement's WorkspaceState (deriveWorkspaceState via useActiveEngagements): the button names the
 * actual next step for the trial balance ("Review account classifications", "View results", …) instead of a generic
 * "Resume", and opens the trial balance page for the same entity, period and current upload (the upload id travels in
 * the URL, so refresh and Back keep it). It only chooses words and a destination; every page it opens re-reads and
 * re-checks everything.
 */
import type { WorkspaceState } from "./types";
import { buildPrepareReviewRoute, buildPrepareUploadRoute } from "./resolveActiveUpload";

export type EngagementActionKind = "upload" | "progress" | "review" | "correct" | "results";

export interface EngagementNextAction {
  kind: EngagementActionKind;
  label: string;
  href: string;
}

export const ENGAGEMENT_ACTION_LABELS: Readonly<Record<EngagementActionKind, string>> = Object.freeze({
  upload: "Upload trial balance",
  progress: "View check progress",
  review: "Review account classifications",
  correct: "See what to correct",
  results: "View results",
});

export function engagementNextAction(state: WorkspaceState): EngagementNextAction {
  const { companyId: c, periodYear: y, currentUploadId: uploadId } = state;
  const make = (kind: EngagementActionKind, href: string): EngagementNextAction => ({ kind, label: ENGAGEMENT_ACTION_LABELS[kind], href });
  switch (state.missions.prepare.status) {
    case "not_started":
      return make("upload", buildPrepareUploadRoute(c, y));
    case "in_progress":
      return make("progress", buildPrepareUploadRoute(c, y, uploadId));
    case "review_required":
      return make("review", buildPrepareReviewRoute(c, y, uploadId));
    case "blocked": {
      // The state's own Prepare destination (e.g. the file's options when the checks blocked it), for this upload.
      const own = state.nextAction.mission === "prepare" ? state.nextAction.href : null;
      const manage = own?.includes("manage=source");
      const href = buildPrepareUploadRoute(c, y, uploadId);
      return make("correct", manage ? `${href}${href.includes("?") ? "&" : "?"}manage=source` : href);
    }
    default:
      return make("results", buildPrepareUploadRoute(c, y, uploadId));
  }
}

/** Where the account home's first upload opens its result: that exact upload's trial balance page. */
export function firstUploadResultRoute(companyId: string, periodYear: number, uploadId: string): string {
  return buildPrepareUploadRoute(companyId, periodYear, uploadId);
}
