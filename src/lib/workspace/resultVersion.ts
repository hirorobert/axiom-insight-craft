/**
 * Which check set a stored trial-balance result was produced by (Phase 1 §3.2).
 *
 * A result recorded before processing milestones existed has no processing_result.ingestion.milestones. Its history,
 * fingerprint and approvals are kept exactly as recorded, but it is never presented as passing the current check set.
 * Every surface (the Prepare checks, the Overview and the hub) reads this one fact and shows the same words.
 * Reprocessing creates a new version through the existing processing authority; nothing here rewrites history.
 */

export const EARLIER_VERSION_LABEL = "Checked by an earlier version";
export const EARLIER_VERSION_REASON = "Checked by an earlier version. Reprocess to apply current checks.";

/** True when the stored result records the processing milestones (the current check set). */
export function hasMilestoneRecord(processingResult: unknown): boolean {
  const pr = processingResult !== null && typeof processingResult === "object" && !Array.isArray(processingResult)
    ? processingResult as Record<string, unknown> : null;
  const ingestion = pr && pr.ingestion !== null && typeof pr.ingestion === "object" && !Array.isArray(pr.ingestion)
    ? pr.ingestion as Record<string, unknown> : null;
  return !!ingestion && Array.isArray(ingestion.milestones);
}
