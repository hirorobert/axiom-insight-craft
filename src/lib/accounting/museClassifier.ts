/**
 * museClassifier.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 4/5: evidence-ladder classifier over TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.
 *
 * Pure function, READ ONLY — same discipline as Slice 2's detectEntityContext.
 * Takes account codes as plain input, returns ClassificationOutcome[]. Writes
 * NOTHING: no account_mappings upsert, no processing_result mutation. Wiring
 * this into the real process-trial-balance classifier (Tiers 1-6, PHASE-0 §5)
 * is a later, separate integration step — this module only proves what the
 * evidence ladder WOULD decide, exactly what Section XXI's dry-run requires.
 *
 * Evidence ladder (Section VII), as actually implemented here:
 *   Tier 2 — exact naturalAccountCode match in the MUSE/IPSAS rule pack.
 *   Tier 8 — no match: UNRESOLVED. Never guessed.
 * Tiers 1 (prior confirmed mapping), 3-7 are NOT implemented in this slice —
 * there is no account_mappings/audited-mapping-memory integration yet
 * (Slice 12), and no lexical fallback rules beyond the exact-code rule pack
 * (deliberately: PHASE-0 confirmed no authoritative GFS lookup table exists
 * to build a safe lexical/fuzzy tier from — inventing one would be exactly
 * the fabricated-certainty failure mode Section XVIII prohibits).
 */

import type { MuseIpsasRule } from "./museIpsasRulePack";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";
import type { ConfidenceLevel, EvidenceItem, EvidenceSource } from "./entityContext";
import { inferBalanceSideEvidence, type BalanceSide } from "./balanceSideEvidence";

export type ClassificationOutcomeKind = "AUTO_MAPPED_RULE" | "REVIEW_SUGGESTED" | "UNRESOLVED";

export interface AccountToClassify {
  naturalAccountCode: string;
  accountName: string;
  balance: number;
}

export interface ClassificationOutcome {
  naturalAccountCode: string;
  accountName: string;
  outcome: ClassificationOutcomeKind;
  accountNature?: MuseIpsasRule["accountNature"];
  presentationCode?: MuseIpsasRule["presentationCode"];
  confidence: ConfidenceLevel;
  confidenceSource: EvidenceSource;
  ruleId?: string;
  ruleVersion?: string;
  evidence: EvidenceItem[];
  reason: string;
  /** Directive Section VII: a lower tier must never override a contradictory higher tier. Populated when more than one rule matches with different outcomes — should be empty by construction here (naturalAccountCode is unique per rule pack, see museIpsasRulePack.test.ts), kept for shape-compatibility with future tiers. */
  conflicts: string[];
  /**
   * Phase 3, Tier 7 only (balanceSideEvidence.ts). Present exclusively when
   * no exact-code rule matched but a non-zero balance contributed weak,
   * directional-only evidence. Absent for Tier 2 matches and for Tier 8
   * (true zero-evidence) results — never retrofitted onto them. Sign is
   * evidence only: this field's presence never implies accountNature/
   * presentationCode/ruleId/ruleVersion were set — they remain undefined
   * for every Tier 7 outcome.
   */
  evidenceTier?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  balanceSide?: BalanceSide;
  requiresReview?: true;
}

const RULES_BY_CODE: Map<string, MuseIpsasRule> = new Map(
  TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((rule) => [rule.naturalAccountCode, rule]),
);

/**
 * Classify one account. HIGH-confidence rule matches become AUTO_MAPPED_RULE
 * — which, per Section VII, "MUST NOT mean professionally approved", only
 * that the deterministic rule fired. MEDIUM/LOW-confidence rule matches
 * (the genuinely ambiguous cases the rule pack itself flags, e.g. unsuffixed
 * '14xxxxxx' exchange-status-unconfirmed codes) become REVIEW_SUGGESTED — the
 * rule found something, but not confidently enough to auto-apply. No match
 * at all is UNRESOLVED (Tier 8) — never a guess (C4).
 */
export function classifyMuseAccount(account: AccountToClassify): ClassificationOutcome {
  const rule = RULES_BY_CODE.get(account.naturalAccountCode);

  if (!rule) {
    // Tier 2 (exact-code) evidence has already failed to fire — this is the
    // one, structurally-guaranteed place Tier 7 (balance-side evidence) may
    // run, since it cannot be reached any other way. A zero balance
    // contributes no directional evidence at all (Design Gate Step 6's
    // conservative adjudication) — inferBalanceSideEvidence returns null in
    // that case, and the account stays bare Tier 8 below, unchanged from
    // before this slice.
    const tier7 = inferBalanceSideEvidence(account.balance);

    if (tier7) {
      return {
        naturalAccountCode: account.naturalAccountCode,
        accountName: account.accountName,
        outcome: "UNRESOLVED",
        // Sign is evidence only: accountNature, presentationCode, ruleId,
        // and ruleVersion are never set from balance side alone.
        confidence: tier7.confidence,
        confidenceSource: "UNKNOWN",
        evidence: [{ source: "UNKNOWN", detail: tier7.reason }],
        reason: `No rule in TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 matches natural account code '${account.naturalAccountCode}'. ${tier7.reason} Weak evidence only — cannot independently resolve this account; requires professional review.`,
        conflicts: [],
        evidenceTier: tier7.evidenceTier,
        balanceSide: tier7.balanceSide,
        requiresReview: tier7.requiresReview,
      };
    }

    return {
      naturalAccountCode: account.naturalAccountCode,
      accountName: account.accountName,
      outcome: "UNRESOLVED",
      confidence: "NONE",
      confidenceSource: "UNKNOWN",
      evidence: [],
      reason: `No rule in TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 matches natural account code '${account.naturalAccountCode}'. Not previously observed in the Arusha DC MUSE reference data this rule pack was built from.`,
      conflicts: [],
    };
  }

  const evidence: EvidenceItem[] = [
    {
      source: rule.confidenceSource,
      detail: rule.evidenceDetail,
      ref: rule.ruleId,
    },
  ];

  const outcome: ClassificationOutcomeKind =
    rule.confidence === "HIGH" ? "AUTO_MAPPED_RULE" : "REVIEW_SUGGESTED";

  return {
    naturalAccountCode: account.naturalAccountCode,
    accountName: account.accountName,
    outcome,
    accountNature: rule.accountNature,
    presentationCode: rule.presentationCode,
    confidence: rule.confidence,
    confidenceSource: rule.confidenceSource,
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    evidence,
    reason:
      outcome === "AUTO_MAPPED_RULE"
        ? `Matched rule ${rule.ruleId} v${rule.version} at HIGH confidence.`
        : `Matched rule ${rule.ruleId} v${rule.version}, but only at ${rule.confidence} confidence — surfaced for professional review rather than auto-applied.`,
    conflicts: [],
  };
}

/**
 * Classify a batch of accounts (Section XXI dry-run shape). Read-only, no
 * writes — callers own what (if anything) happens with the result.
 */
export function classifyMuseAccounts(accounts: AccountToClassify[]): ClassificationOutcome[] {
  return accounts.map(classifyMuseAccount);
}

export interface DryRunSummary {
  total: number;
  autoMappedRule: number;
  reviewSuggested: number;
  unresolved: number;
}

/** Section XXI: "Report counts: AUTO_MAPPED_RULE / REVIEW_SUGGESTED / UNRESOLVED." */
export function summarizeDryRun(outcomes: ClassificationOutcome[]): DryRunSummary {
  return {
    total: outcomes.length,
    autoMappedRule: outcomes.filter((o) => o.outcome === "AUTO_MAPPED_RULE").length,
    reviewSuggested: outcomes.filter((o) => o.outcome === "REVIEW_SUGGESTED").length,
    unresolved: outcomes.filter((o) => o.outcome === "UNRESOLVED").length,
  };
}
