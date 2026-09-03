/**
 * evidenceResolverGuards.ts — Ω∞ Phase 3 Foundation Contract.
 *
 * Pure functions only. No DB, no async, no classification/mapping/GFS/
 * taxonomy-matching/confidence-aggregation behavior — see
 * evidenceResolverTypes.ts for the type contract these guards support.
 */

import type { ReportingFramework, EntityClass } from "./entityContext";
import type { BalanceSide } from "./balanceSideEvidence";

/**
 * Which IFRS taxonomy profile (if any) is available for a confirmed
 * reporting framework. Uses the canonical ReportingFramework literals
 * (entityContext.ts) — "ifrs"/"ifrs_sme" are NOT valid members of that type
 * and must never appear here.
 */
export function isTaxonomyAvailable(
  framework: ReportingFramework,
): false | "IFRS_FULL" | "IFRS_SME" {
  if (framework === "IFRS") return "IFRS_FULL";
  if (framework === "IFRS_FOR_SMES") return "IFRS_SME";
  return false; // IPSAS_ACCRUAL, OTHER_CONFIRMED, UNKNOWN -> no official taxonomy
}

/**
 * Whether GFS/Tanzania Government CoA evidence is even entity-gated to
 * apply. Uses the canonical EntityClass literals (entityContext.ts) —
 * "lga"/"central_agency" are NOT valid members of that type. No GFS
 * classification behavior lives here or anywhere in this slice — this gate
 * only answers the applicability question a future GFS-bridge slice would
 * need.
 */
export function isGFSApplicable(entityClass: EntityClass | null): boolean {
  return entityClass === "LOCAL_GOVERNMENT" || entityClass === "CENTRAL_GOVERNMENT";
}

/**
 * Normalizes Tier 7's balance-side casing (DEBIT/CREDIT, from
 * balanceSideEvidence.ts) to the lowercase debit/credit convention used by
 * IFRS taxonomy balance-attribute evidence, so the two can be compared for
 * a CorroborationConflict without a silent casing mismatch.
 */
export function normalizeBalanceSide(side: BalanceSide): "debit" | "credit" {
  return side === "DEBIT" ? "debit" : "credit";
}
