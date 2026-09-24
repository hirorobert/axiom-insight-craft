/**
 * certificationCheckPresentation — how the six-layer certification readiness is SHOWN. Presentation only.
 *
 * Nothing here decides anything. computeCertificationReadiness (verdict, blocker, checks, counts — which the workspace
 * state and stage locks consume) is read, never modified. Classification uses structured identity only:
 *   - layers 1–4 are REQUIRED certification checks (file structure, data quality, arithmetic, classification);
 *   - layers 5–6 are INFORMATIONAL assessments (supporting evidence, prior-period signal), which process-trial-balance
 *     emits as signals that never drive is_blocking/requires_review.
 * Tone comes from the structured `severity` field only: info → neutral, warning → warning, error → failure, and any
 * unknown or missing severity → "unavailable" (fail closed, never passed). The `message` text is displayed as-is and is
 * NEVER read as state: rewording it cannot change a classification, a tone, the count or anything else.
 *
 * The headline counts the four required layers only ("Required checks passed · 4/4"). Before this, an upload whose
 * supporting evidence was never evaluated read "Checks passed · 6/6".
 *
 * If friendly per-state labels (for example "Not evaluated", "No prior-period certification available") are wanted, the
 * producer must first emit a structured state field — a separate producer-contract enhancement, not prose parsing.
 */

import type { PreflightCheck, PreflightResult, PreflightVerdict } from "./computePreflight";
import type { CertificationReadinessInput, TbCertificationRow } from "./computeCertificationReadiness";

export const REQUIRED_LAYERS = [1, 2, 3, 4] as const;
export const INFORMATIONAL_LAYERS = [5, 6] as const;
const LAYER_CHECK_ID: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "l1_structure", 2: "l2_data_quality", 3: "l3_arithmetic", 4: "l4_classification", 5: "l5_supporting_evidence", 6: "l6_prior_period",
};
const KNOWN_SEVERITY = new Set(["error", "warning", "info"]);

/** How a row is drawn. Only "passed" is a success; "informational" and "unavailable" are neutral. */
export type CheckTone = "passed" | "failed" | "review" | "pending" | "informational" | "unavailable";

export interface PresentedCheck {
  id: string;
  label: string;
  tone: CheckTone;
  text: string;
}

export interface PresentedReadiness {
  countLabel: string;
  required: PresentedCheck[];
  informational: PresentedCheck[];
  /** True for the six-layer authoritative readiness; false for the legacy five-check projection (unchanged). */
  layered: boolean;
}

/**
 * The certification row whose exceptions computeCertificationReadiness draws its layer checks from, chosen by the
 * same rules (the current upload's authoritative row, else its latest row; none on a failed read). Read-only mirror;
 * a test keeps it in step with the readiness function in every branch.
 */
export function certificationRowForDisplay(input: CertificationReadinessInput): TbCertificationRow | null {
  if (!input.uploadExists || input.fetchFailed) return null;
  if (input.authoritative && input.authoritative.upload_id === input.currentUploadId) return input.authoritative;
  return input.latestForUpload ?? null;
}

/** Tone for one layer from the structured severity of its entries, or null when the layer has no entries. */
function severityTone(row: TbCertificationRow, layer: number): "failed" | "review" | "neutral" | "unavailable" | null {
  const entries = Array.isArray(row.exceptions) ? row.exceptions.filter((e) => e && e.layer === layer) : [];
  if (entries.length === 0) return null;
  if (entries.some((e) => e.severity === "error")) return "failed";
  if (entries.some((e) => !KNOWN_SEVERITY.has(e.severity as string))) return "unavailable";
  if (entries.some((e) => e.severity === "warning")) return "review";
  return "neutral";
}

const VERDICT_WORD: Record<PreflightVerdict, string> = {
  certified: "Required checks passed",
  review: "Needs review",
  blocked: "Checks failed",
  pending: "Checking",
  stale: "Out of date",
  unknown: "Unverified",
  superseded: "Not current",
};

function presentRequired(check: PreflightCheck, row: TbCertificationRow | null, layer: number): PresentedCheck {
  const base = { id: check.id, label: check.label, text: check.detail };
  // An entry with an unknown/missing severity is never counted as a pass, whatever readiness concluded.
  if (row && severityTone(row, layer) === "unavailable") return { ...base, tone: "unavailable", text: "Assessment unavailable — not counted" };
  return { ...base, tone: check.state };
}

function presentInformational(check: PreflightCheck, row: TbCertificationRow | null, layer: number): PresentedCheck {
  const base = { id: check.id, label: check.label, text: check.detail };
  if (!row) return { ...base, tone: check.state === "pending" ? "pending" : "unavailable" };
  const tone = severityTone(row, layer);
  if (tone === null) return { ...base, tone: "unavailable", text: "Not available for this certification" };
  if (tone === "failed") return { ...base, tone: "failed" };
  if (tone === "review") return { ...base, tone: "review" };
  if (tone === "unavailable") return { ...base, tone: "unavailable", text: "Assessment unavailable — not counted" };
  return { ...base, tone: "informational" };
}

/**
 * @param row the row from certificationRowForDisplay(); omit it only for the legacy five-check projection.
 */
export function presentReadiness(result: PreflightResult, legacyVerdictLabel: string, row: TbCertificationRow | null = null): PresentedReadiness {
  const byId = new Map(result.checks.map((c) => [c.id, c]));
  const layered = [...REQUIRED_LAYERS, ...INFORMATIONAL_LAYERS].every((l) => byId.has(LAYER_CHECK_ID[l]));
  if (!layered) {
    // The legacy five-check projection (computePreflight): every check is a real check; unchanged.
    const required = result.checks.map((c) => ({ id: c.id, label: c.label, tone: c.state as CheckTone, text: c.detail }));
    return { layered, required, informational: [], countLabel: `${legacyVerdictLabel} · ${result.passedCount}/${result.totalCount}` };
  }
  const required = REQUIRED_LAYERS.map((l) => presentRequired(byId.get(LAYER_CHECK_ID[l])!, row, l));
  const informational = INFORMATIONAL_LAYERS.map((l) => presentInformational(byId.get(LAYER_CHECK_ID[l])!, row, l));
  const passed = required.filter((c) => c.tone === "passed").length;
  // "Required checks passed" only when every required layer really shows passed; otherwise say what is true.
  const allPassed = passed === required.length;
  const word = result.verdict === "certified" && !allPassed ? "Certified" : VERDICT_WORD[result.verdict];
  const suffix = result.verdict === "certified" && !allPassed ? " required" : "";
  return { layered, required, informational, countLabel: `${word} · ${passed}/${required.length}${suffix}` };
}
