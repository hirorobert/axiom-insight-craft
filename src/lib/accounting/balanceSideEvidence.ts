/**
 * balanceSideEvidence.ts — Ω∞ Phase 3, Tier 7 of the 8-Tier Evidence Ladder.
 *
 * Universal, jurisdiction-neutral accounting evidence: an account's net
 * balance side (debit-positive vs credit-positive), per the codebase's one
 * established sign convention (process-trial-balance/index.ts:
 * `balance = debit - credit`). Contains zero MUSE/Tanzania/TRA/EFDMS/IPSAS
 * terminology or assumptions — this is true of every double-entry ledger
 * anywhere, not a Tanzania-specific fact.
 *
 * SIGN IS EVIDENCE ONLY (directive invariant #3, PART X). A debit balance
 * does not mean asset or expense; a credit balance does not mean liability,
 * revenue, or equity — every nature category has real members on both
 * sides once contra-accounts exist (e.g. accumulated depreciation is a
 * credit-side contra-asset; see museIpsasRulePack.ts's own documented
 * '61461101 Accumulated Depreciation' case). This module therefore NEVER
 * returns an account nature, a presentation code, or a classification —
 * only the raw directional observation plus the fixed, hardcoded
 * provenance fields (LOW confidence, requiresReview true) that make clear
 * this can never independently resolve an account.
 *
 * Zero-balance adjudication (Design Gate Step 6): V5's Tier 7 text does not
 * explicitly settle the zero-balance case. Per the conservative-default
 * instruction, a zero balance carries no directional sign evidence at all
 * -- inferBalanceSideEvidence() returns null in that case, and callers must
 * fall through to Tier 8 (bare UNRESOLVED, confidence NONE, no evidence)
 * rather than manufacturing a LOW-confidence "ZERO" evidence entry from an
 * absence of direction.
 */

export type BalanceSide = "DEBIT" | "CREDIT";

export interface BalanceSideEvidence {
  evidenceTier: 7;
  balanceSide: BalanceSide;
  confidence: "LOW";
  requiresReview: true;
  /** Describes the observation only -- never asserts or implies a nature. */
  reason: string;
}

/**
 * Infer Tier 7 balance-side evidence from a signed net balance. Returns
 * null for a zero balance -- there is no directional sign evidence to
 * report, and this function must never invent LOW-confidence evidence from
 * nothing (C4 / Section XVIII). Callers receiving null must treat the
 * account as Tier 8 (no evidence contributed by this tier), not Tier 7.
 */
export function inferBalanceSideEvidence(balance: number): BalanceSideEvidence | null {
  if (balance === 0) return null;

  const balanceSide: BalanceSide = balance > 0 ? "DEBIT" : "CREDIT";

  return {
    evidenceTier: 7,
    balanceSide,
    confidence: "LOW",
    requiresReview: true,
    reason:
      balanceSide === "DEBIT"
        ? "Net debit balance observed."
        : "Net credit balance observed.",
  };
}
