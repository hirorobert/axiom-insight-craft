/**
 * The one status vocabulary for a trial-balance result (Phase 1 §3.5), shown identically in the sidebar, the Overview
 * and the Prepare page. Findings are ordered blocking → needs confirmation → review; a check that did not run says why.
 *
 * Review-only findings (§3.6) and a confirmation (§3.3) never change what a certified result unlocks: they change the
 * words every surface shows, from the same stored record, so no surface says "Reviewed" while another asks for review.
 */

import type { WorkspaceState } from "./types";
import { EARLIER_VERSION_LABEL } from "./resultVersion";

export type FindingKind = "blocking" | "needs_confirmation" | "review";

export const FINDING_ORDER: readonly FindingKind[] = ["blocking", "needs_confirmation", "review"];

/** Plain headings for each group of findings. */
export const FINDING_HEADING: Readonly<Record<FindingKind, string>> = {
  blocking: "What to correct in the file",
  needs_confirmation: "Needs your confirmation",
  review: "For review",
};

/** The status words, by what the result shows. Every surface uses these exact strings. */
export const STATUS_WORDS = {
  blocked: "Blocked",
  needsConfirmation: "Needs confirmation",
  needsReview: "Needs review",
  reviewed: "Reviewed",
  processing: "Processing",
  none: "No trial balance",
} as const;

/** Findings a person answers (same entity? yes or no), as opposed to findings they look at. */
const CONFIRMATION_CODES: ReadonlySet<string> = new Set(["ENTITY_NAME_DIFFERS"]);

export function findingKind(severity: unknown, code: unknown): FindingKind | null {
  if (severity === "blocking") return "blocking";
  if (severity !== "review") return null;
  return typeof code === "string" && CONFIRMATION_CODES.has(code) ? "needs_confirmation" : "review";
}

/** The most important open non-blocking finding in a stored result, or null: what every surface names first. */
export function openFindingKind(processingResult: unknown): Exclude<FindingKind, "blocking"> | null {
  const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const issues = obj(obj(processingResult)?.ingestion)?.issues;
  if (!Array.isArray(issues)) return null;
  const kinds = new Set(issues.map((i) => findingKind(obj(i)?.severity, obj(i)?.code)));
  return kinds.has("needs_confirmation") ? "needs_confirmation" : kinds.has("review") ? "review" : null;
}

/** The status word for a certified result with an open non-blocking finding. */
export const openFindingWord = (kind: Exclude<FindingKind, "blocking">): string =>
  (kind === "needs_confirmation" ? STATUS_WORDS.needsConfirmation : STATUS_WORDS.needsReview);

/**
 * The sidebar word for the Prepare stage: the same words as the Prepare page and the Overview. An open confirmation or
 * review finding on a reviewed trial balance is named; null when the stage has no trial-balance word (the caller's own).
 */
export function prepareStatusWord(status: string, openFinding?: "needs_confirmation" | "review" | null): string | null {
  if ((status === "passed" || status === "signed") && openFinding) return openFindingWord(openFinding);
  const words: Record<string, string> = { passed: STATUS_WORDS.reviewed, review_required: STATUS_WORDS.needsReview, blocked: STATUS_WORDS.blocked, in_progress: STATUS_WORDS.processing };
  return words[status] ?? null;
}

/**
 * The header's status word (Phase 2 §5.1: entity · period · status): the same trial-balance vocabulary as the sidebar,
 * the Overview and the page.
 */
export function headerStatusWord(state: Pick<WorkspaceState, "missions" | "openFinding" | "checkedByEarlierVersion" | "currentUploadId">): string {
  const prepare = state.missions.prepare?.status ?? "not_started";
  if (!state.currentUploadId) return STATUS_WORDS.none;
  if ((prepare === "passed" || prepare === "signed") && state.checkedByEarlierVersion) return EARLIER_VERSION_LABEL;
  return prepareStatusWord(prepare, state.openFinding) ?? (prepare === "signed" ? "Signed off" : STATUS_WORDS.processing);
}
