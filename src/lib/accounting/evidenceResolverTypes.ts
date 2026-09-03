/**
 * evidenceResolverTypes.ts — Ω∞ Phase 3 Foundation Contract.
 *
 * PURE TYPES ONLY. No logic, no Supabase I/O, no resolver behavior. This is
 * the type contract certified by the Phase 3 Foundation Contract Gate
 * (SAFF-PHASE3-ARCHITECTURE-HARDENING.md Section O, as corrected by the
 * Gate's own findings against repository truth) — nothing here is wired
 * into any live code path.
 *
 * Reuses canonical repository types rather than duplicating them:
 *   EntityClass, ReportingFramework, ConfidenceLevel, EvidenceSource,
 *   EvidenceItem  — from ./entityContext
 *   AccountNature — from ../safisha/types (Phase 0's generic 5-value enum;
 *   distinct from museIpsasRulePack.ts's IPSAS-locked uppercase variant,
 *   which stays scoped to Tier 2's rule pack — bridging the two is a later
 *   resolver-slice concern, not this foundation slice's)
 *   BalanceSide   — from ./balanceSideEvidence (Tier 7, unchanged)
 *
 * Orthogonal dimensions: accountNature, fsPresentation,
 * sourceClassification, taxonomyConcept. Deliberately excludes:
 *   - taxTreatment     — belongs to KINGA/jurisdiction tax computation only
 *   - cashFlowCategory — belongs to the later V5 cash-flow phase; already
 *     served today by cashFlowEngines.ts from account_mappings.classification
 *     (operating_activities | investing_activities | financing_activities)
 *
 * No GFS enumeration: the full verified Tanzania/GFSM economic-code
 * enumeration does not exist in this repository. sourceClassification stays
 * an opaque typed external code with provenance — never a frozen
 * GFSGroup-style enum, even provisionally.
 *
 * No confidence-aggregation policy: EvidenceStrength carries three
 * independent ConfidenceLevel values. Combining them into one
 * classificationConfidence is a rule-level decision for a future resolver
 * slice, not a universal function baked into the foundation types.
 *
 * No persistence: everything here is COMPUTED and RETURNED only. No table,
 * migration, or write path exists for any of these shapes yet.
 *
 * Deterministic: no field here carries an execution timestamp, a random id,
 * or any other non-reproducible value. Time/engine provenance belongs to an
 * external envelope (see engine_runs), not to these semantic structures.
 */

import type {
  EntityClass,
  ReportingFramework,
  ConfidenceLevel,
  EvidenceSource,
  EvidenceItem,
} from "./entityContext";
import type { AccountNature } from "../safisha/types";
import type { BalanceSide } from "./balanceSideEvidence";

// ── Orthogonal dimensions ────────────────────────────────────────────────────

export type AccountDimension =
  | "accountNature"
  | "fsPresentation"
  | "sourceClassification"
  | "taxonomyConcept";
// Deliberately absent: "taxTreatment" (KINGA only), "cashFlowCategory" (later
// V5 cash-flow phase — see cashFlowEngines.ts for the live authority this
// dimension would otherwise collide with).

// ── Confidence (three orthogonal values, reused ConfidenceLevel) ────────────

export interface EvidenceStrength {
  sourceAuthority: ConfidenceLevel;
  mappingConfidence: ConfidenceLevel;
  classificationConfidence: ConfidenceLevel;
}
// No combination policy (e.g. "classificationConfidence = min(...)") is
// defined here — that is an explicit rule-level decision for a future
// resolver slice, not a universal foundation-type behavior.

// ── Per-dimension proposal (discriminated union) ─────────────────────────────

interface BaseProposal {
  strength: EvidenceStrength;
  requiresReview: boolean;
  tier: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  evidenceSource: EvidenceSource;
  provenance: EvidenceItem[];
}

export interface AccountNatureProposal extends BaseProposal {
  dimension: "accountNature";
  proposal: AccountNature | null;
}

export interface FsPresentationProposal extends BaseProposal {
  dimension: "fsPresentation";
  /** Which statement/section this account belongs in -- the one thing this dimension exclusively owns. */
  statementSection: string | null;
  mappingMethod: "EXACT_CODE" | "LABEL_SIMILARITY" | "STATEMENT_SECTION";
  /** Identifies the source/profile of THIS statementSection mapping's evidence -- provenance, not a taxonomy-concept claim. */
  taxonomyProfile: "IFRS_FULL" | "IFRS_SME" | null;
  // taxonomyConcept and balanceAttribute deliberately absent: both are
  // per-taxonomy-element metadata (which XBRL concept, and that concept's
  // own IASB-defined normal balance) -- exclusively TaxonomyConceptProposal's
  // ownership. Keeping either here would let an fsPresentation winner and a
  // taxonomyConcept winner disagree about the same underlying fact.
}

export interface SourceClassificationProposal extends BaseProposal {
  dimension: "sourceClassification";
  /**
   * An opaque external classification/code (e.g. a MUSE natural account
   * code, a future verified statutory code) — never a frozen enum. No GFS
   * (or any other) economic-code enumeration exists in this repository yet;
   * inventing one here would overclaim completeness the evidence doesn't
   * support.
   */
  proposal: string | null;
}

export interface TaxonomyConceptProposal extends BaseProposal {
  dimension: "taxonomyConcept";
  proposal: string | null; // XBRL taxonomy element name
  /**
   * The taxonomy element's own IASB-defined normal balance -- moved here
   * from FsPresentationProposal: it describes the CONCEPT, not the
   * statement section. Exclusively owned here so a corroboration check
   * against Tier 7's observed balance side has exactly one source of truth.
   */
  balanceAttribute: "debit" | "credit" | null;
}

export type DimensionProposal =
  | AccountNatureProposal
  | FsPresentationProposal
  | SourceClassificationProposal
  | TaxonomyConceptProposal;

// ── Evidence observation (what was evaluated, before any dimension "wins") ──

export interface EvidenceObservation {
  tier: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  evidenceSource: EvidenceSource;
  detail: string;
  ref?: string;
  informsDimensions: AccountDimension[];
  strength: EvidenceStrength;
}

/**
 * Tier 7's own observation shape — mirrors balanceSideEvidence.ts's already
 * certified BalanceSideEvidence exactly. informsDimensions is always empty:
 * it names the dimensions this evidence can DIRECTLY RESOLVE (i.e. win a
 * DimensionResolution outright) — not every dimension it may corroborate.
 * Tier 7 never produces a DimensionProposal on its own and therefore never
 * directly resolves anything; it only feeds a CorroborationConflict check
 * against other tiers' evidence, which is a separate, weaker relationship
 * than "informing" a dimension. No codeRangeSuggestion field — the
 * certified Tier 7 implementation has no code-range logic at all.
 */
export interface BalanceSideObservation extends EvidenceObservation {
  tier: 7;
  balanceSide: BalanceSide;
  informsDimensions: [];
}

// ── Per-dimension resolution (what won, what lost, at what tier) ────────────

/**
 * Generic shape shared by every dimension's resolution -- winningProposal
 * and consideredProposals are BOTH pinned to the SAME proposal type as the
 * dimension tag, so an accountNature resolution structurally cannot carry
 * an FsPresentationProposal (or any other mismatched shape) as its winner
 * or among its considered candidates.
 */
type ResolutionFor<D extends AccountDimension, P extends DimensionProposal> = {
  dimension: D;
  winningProposal: P | null;
  consideredProposals: P[];
  requiresReview: boolean;
};

export type AccountNatureResolution = ResolutionFor<"accountNature", AccountNatureProposal>;
export type FsPresentationResolution = ResolutionFor<"fsPresentation", FsPresentationProposal>;
export type SourceClassificationResolution = ResolutionFor<"sourceClassification", SourceClassificationProposal>;
export type TaxonomyConceptResolution = ResolutionFor<"taxonomyConcept", TaxonomyConceptProposal>;

export type DimensionResolution =
  | AccountNatureResolution
  | FsPresentationResolution
  | SourceClassificationResolution
  | TaxonomyConceptResolution;
// No global lowestResolvingTier, and no winningTier field either: the
// authoritative winning tier is `resolution.winningProposal?.tier` -- a
// second field tracking the same fact could drift out of sync with the
// proposal's own tier, which is structurally impossible when there is only
// one field to read. If winningProposal is null, there is no winning tier.
// Each dimension can still resolve at its own tier independently
// (sourceClassification at Tier 1, fsPresentation at Tier 3, accountNature
// at Tier 4, simultaneously, without information loss).

// ── Corroboration conflict ───────────────────────────────────────────────────

export interface CorroborationConflict {
  type: "BALANCE_SIDE_CONFLICT";
  observed: "debit" | "credit";
  taxonomyExpected: "debit" | "credit";
  severity: "REVIEW_SIGNAL";
  possibleReasons: (
    | "CONTRA_ACCOUNT"
    | "PRESENTATION_NETTING"
    | "RECLASSIFICATION"
    | "GENUINE_MISMATCH"
  )[];
}

// ── Machine evidence resolver output (deterministic, no timestamp) ──────────

export interface MachineEvidenceResolverOutput {
  accountId: string;
  companyId: string;
  periodYear: number;
  entityClass: EntityClass | null;
  reportingFramework: ReportingFramework;
  evidenceObservations: EvidenceObservation[];
  dimensionResolutions: DimensionResolution[];
  unresolvedDimensions: AccountDimension[];
  corroborationConflicts: CorroborationConflict[];
  requiresReviewOverall: boolean;
}
// Deliberately no resolvedAt/createdAt/Date.now()/random id — time and
// engine-run provenance belong to an external envelope (see engine_runs),
// never inside this semantic structure. Same inputs + same rules must be
// capable of producing the same output.

// ── Professional authority (domain view, not a persisted shape) ─────────────

/**
 * COMPUTED DOMAIN VIEW — NOT A DATABASE RECORD. Derived by a future reader
 * from account_review_decisions (the real, append-only professional-
 * decision ledger — supabase/migrations/20260816120000_account_review_authority.sql).
 * No approvedDimensions/confirmed/overridden/flagged column exists in that
 * table; this type only names fields that map from real columns
 * (decision_action, created_at, firm_member_id). No DB read is implemented
 * in this slice — this is a type contract only.
 *
 * Deliberately named hasEffectiveDecision/decidedBy/decidedAt rather than
 * hasConfirmedDecision/approvedBy/approvedAt: all three real
 * decision_action values -- USER_ACCEPTED_SUGGESTION,
 * USER_MANUAL_CLASSIFICATION, and MARK_NON_REPORTING_ACCOUNT -- are
 * authoritative professional decisions the moment they're recorded, but
 * MARK_NON_REPORTING_ACCOUNT suppresses an account from review rather than
 * approving any classification for it. "Confirmed"/"approved" would wrongly
 * imply a classification was accepted in that case.
 */
export interface ProfessionalAuthorityResult {
  reviewAccountKey: string;
  hasEffectiveDecision: boolean;
  decisionAction:
    | "USER_ACCEPTED_SUGGESTION"
    | "USER_MANUAL_CLASSIFICATION"
    | "MARK_NON_REPORTING_ACCOUNT"
    | null;
  decidedBy?: string; // firm_members.id — never auth.users.id
  decidedAt?: string; // account_review_decisions.created_at of the latest row
  /**
   * Freshly computed by a future resolver run, not reconstructed from
   * history — account_review_decisions does not persist a snapshot of the
   * machine's proposal at decision time, so no "AtDecisionTime" field is
   * ever offered here.
   */
  machineProposalAtEvaluationTime?: MachineEvidenceResolverOutput;
}
