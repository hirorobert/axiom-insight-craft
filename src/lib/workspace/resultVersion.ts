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

/**
 * The finding rules a result was evaluated under (processing_result.ingestion.rules_generation, written by
 * process-trial-balance from generation 7). A result without it was evaluated by an earlier engine: it is NOT a result
 * of the current checks (the required entity decision, the database-computed requirements and the evaluation record).
 */
export const CURRENT_RULES_GENERATION = 7;
export function rulesGeneration(processingResult: unknown): number | null {
  const pr = processingResult !== null && typeof processingResult === "object" && !Array.isArray(processingResult)
    ? processingResult as Record<string, unknown> : null;
  const ingestion = pr && pr.ingestion !== null && typeof pr.ingestion === "object" && !Array.isArray(pr.ingestion)
    ? pr.ingestion as Record<string, unknown> : null;
  const g = ingestion?.rules_generation;
  return typeof g === "number" && Number.isInteger(g) ? g : null;
}

/**
 * True only for a result of the CURRENT check set: the processing milestones AND the current finding rules. Anything else
 * keeps its recorded history and approvals and stays in force, but is shown as checked by an earlier version — never as
 * having passed today's checks — with the re-check that applies them.
 */
export function isCurrentCheckSet(processingResult: unknown): boolean {
  return hasMilestoneRecord(processingResult) && (rulesGeneration(processingResult) ?? 0) >= CURRENT_RULES_GENERATION;
}
