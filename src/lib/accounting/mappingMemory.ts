/**
 * mappingMemory.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 12: audited mapping memory (Section XV).
 * Ω∞ Phase 8 extends this file in place (V5: "Machine-Side Classification
 * Provenance") rather than creating a competing memory system.
 *
 * Pure contracts + pure selection logic, READ ONLY — no Supabase I/O. The
 * actual persistence is `account_mapping_memory`
 * (supabase/migrations/20260811000000_account_mapping_memory.sql plus
 * 20260813151156's decision_kind/suggestion_shown addition), an
 * append-only table this session could not apply (no live DB access this
 * session — see Task #106 history). This module is usable and testable
 * regardless of whether that migration has been applied yet; the edge
 * function that would write real rows remains a separate, later
 * integration — Phase 8 does not build it (see §5 below).
 *
 * Mirrors the migration's columns 1:1 (camelCase here, snake_case there) so
 * there is exactly one schema, described in two places, never two designs.
 *
 * Ω∞ Phase 8 — the resolver at the bottom of this file
 * (resolveMappingMemorySuggestion) answers a DIFFERENT question than
 * everything above it: "may a PRIOR professional decision recorded in
 * account_review_decisions become a CURRENT machine suggestion?" It
 * consumes a caller-supplied HistoricalDecisionContext[] — never queries
 * Supabase, never assumes account_mapping_memory has been populated (it
 * has not — zero rows exist in any live project). The three mapping
 * concepts (Rule 11) stay distinct: account_mappings (mutable current
 * projection) / account_mapping_memory (evidence store, schema-ready,
 * unpopulated) / account_review_decisions (immutable professional
 * history — the only table with real data today, and this resolver's
 * actual input). PRIOR MAPPING ≠ CURRENT AUTHORITY throughout: this
 * function's output is evidence only, never a write, never an implicit
 * Save, never professional approval.
 */

import type {
  AccountNature,
  IpsasPresentationCode,
} from "./museIpsasRulePack";
import type { ConfidenceLevel, EvidenceSource, ReportingFramework, SourceSystem } from "./entityContext";

// ── Section XV's priority evidence ladder ────────────────────────────────────

export type AuditStatus =
  | "cag_external_audited" // Tier 1 — highest
  | "saff_professionally_approved" // Tier 2
  | "user_approved_current" // Tier 3
  | "system_rule"; // Tier 4 — lowest

const AUDIT_STATUS_PRIORITY: Record<AuditStatus, number> = {
  cag_external_audited: 4,
  saff_professionally_approved: 3,
  user_approved_current: 2,
  system_rule: 1,
};

/** Higher = more authoritative, per Section XV's literal ordering. */
export function auditStatusPriority(status: AuditStatus): number {
  return AUDIT_STATUS_PRIORITY[status];
}

// ── Ω∞ Phase 8: TS/DB contract-drift reconciliation ──────────────────────────
// Migration 20260813151156 (DEFECT-CLASSIFICATION-PROVENANCE-001) added
// decision_kind + suggestion_shown to the LIVE account_mapping_memory
// table; this TypeScript mirror was never updated to match. Reconciled
// here using the migration's own vocabulary and column comments verbatim
// — no renaming, no new DB migration, no redesign.

/**
 * How the decision was reached (migration comment, verbatim intent).
 * MACHINE_RULE = no human in the loop at all — never professional
 * confirmation. ORIGINAL_JUDGEMENT = professional classified with no
 * suggestion on screen. ACCEPTED_SUGGESTION = professional agreed with
 * the machine's proposal. OVERRODE_SUGGESTION = professional replaced it.
 * Never inferred from auditStatus — auditStatus records standing,
 * decisionKind records the act.
 */
export type DecisionKind =
  | "MACHINE_RULE"
  | "ORIGINAL_JUDGEMENT"
  | "ACCEPTED_SUGGESTION"
  | "OVERRODE_SUGGESTION";

/**
 * The machine proposal that was visible at the moment of decision,
 * verbatim — mirrors the DB column comment's exact shape. NULL/absent
 * only when nothing was suggested (ORIGINAL_JUDGEMENT / MACHINE_RULE).
 */
export interface SuggestionSnapshot {
  presentationCode?: IpsasPresentationCode;
  accountNature?: AccountNature;
  noteCode?: string;
  cashFlowClass?: string;
  ruleId?: string;
  ruleVersion?: string;
  confidence?: string;
}

// ── The record itself ────────────────────────────────────────────────────────

export interface MappingMemoryRecord {
  id?: string;
  companyId: string;
  sourceSystem: SourceSystem;
  naturalAccountCode: string | null;
  normalizedAccountName: string;
  reportingFramework: ReportingFramework;
  accountNature: AccountNature;
  presentationCode: IpsasPresentationCode;
  presentationLabel?: string;
  noteCode?: string;
  cashFlowClass?: string;
  effectivePeriodYear: number;
  evidenceSource: EvidenceSource;
  auditStatus: AuditStatus;
  ruleId?: string;
  ruleVersion?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  createdAt?: string;
  /** Ω∞ Phase 8: reconciled against live column decision_kind (20260813151156). */
  decisionKind?: DecisionKind;
  /** Ω∞ Phase 8: reconciled against live column suggestion_shown (20260813151156). */
  suggestionShown?: SuggestionSnapshot;
}

export interface MappingMemoryValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Client-side mirror of the DB's
 * amm_confirmed_fields_required_when_audited CHECK constraint — the SAME
 * rule enforced in two places (TS pre-flight, DB last-resort) rather than
 * trusted only once. Failing here means the write would also fail at the
 * DB, just faster and with a clearer message.
 */
export function validateMappingMemoryRecord(
  record: MappingMemoryRecord,
): MappingMemoryValidationResult {
  const errors: string[] = [];

  if (record.auditStatus !== "system_rule") {
    if (!record.confirmedBy) {
      errors.push(`audit_status '${record.auditStatus}' requires confirmedBy to be set.`);
    }
    if (!record.confirmedAt) {
      errors.push(`audit_status '${record.auditStatus}' requires confirmedAt to be set.`);
    }
  }

  if (record.effectivePeriodYear < 2000 || record.effectivePeriodYear > 2100) {
    errors.push(`effectivePeriodYear ${record.effectivePeriodYear} is outside the sane range 2000-2100.`);
  }

  // Ω∞ Phase 8: mirrors amm_human_decision_declares_kind, amm_suggestion_
  // evidence_matches_kind, amm_machine_rule_has_no_human_actor (migration
  // 20260813151156) — same discipline as the pre-existing checks above:
  // fail here first, faster and clearer than the DB round-trip.
  if (record.auditStatus !== "system_rule" && !record.decisionKind) {
    errors.push(`audit_status '${record.auditStatus}' is a human decision and requires decisionKind to be set.`);
  }

  if (record.decisionKind === "ACCEPTED_SUGGESTION" || record.decisionKind === "OVERRODE_SUGGESTION") {
    if (!record.suggestionShown) {
      errors.push(`decisionKind '${record.decisionKind}' requires suggestionShown to be set — proposal_type != professional decision.`);
    }
  }
  if (record.decisionKind === "ORIGINAL_JUDGEMENT" && record.suggestionShown) {
    errors.push(`decisionKind 'ORIGINAL_JUDGEMENT' asserts no suggestion was shown — suggestionShown must be absent.`);
  }
  if (record.decisionKind === "MACHINE_RULE" && record.confirmedBy) {
    errors.push(`decisionKind 'MACHINE_RULE' has no deciding professional — confirmedBy must be absent.`);
  }

  return { valid: errors.length === 0, errors };
}

// ── Priority selection (Section XV: "Priority evidence: CAG > SAFF > user > rule") ──

/**
 * Given multiple candidate confirmations for the SAME (company, code,
 * period) — e.g. a system rule fired, then a professional later confirmed
 * it — picks the highest-priority one. Ties (same audit_status) break on
 * most recent confirmedAt/createdAt, so a genuine later correction at the
 * same authority level still wins.
 */
export function selectAuthoritativeMapping(
  candidates: MappingMemoryRecord[],
): MappingMemoryRecord | null {
  if (candidates.length === 0) return null;

  return candidates.reduce((best, candidate) => {
    const bestPriority = auditStatusPriority(best.auditStatus);
    const candidatePriority = auditStatusPriority(candidate.auditStatus);
    if (candidatePriority > bestPriority) return candidate;
    if (candidatePriority < bestPriority) return best;

    const bestTime = best.confirmedAt ?? best.createdAt ?? "";
    const candidateTime = candidate.confirmedAt ?? candidate.createdAt ?? "";
    return candidateTime > bestTime ? candidate : best;
  });
}

// ── Never let a prior period silently become "this year's approval" ──────────

/**
 * Section XV: "Do NOT label automatically imported prior audited mapping as
 * current-year professional approval." Structural enforcement: this filters
 * OUT every record whose effectivePeriodYear differs from the target —
 * there is no code path here that lets a prior-period record satisfy a
 * current-period lookup. (Using a prior period's mapping as EVIDENCE when
 * inferring the current period's is detectEntityContext.ts's job via
 * priorConfirmedFramework — a different, explicitly-labelled input — not
 * this function pretending a prior confirmation already covers this year.)
 */
export function findEffectiveMappingForPeriod(
  records: MappingMemoryRecord[],
  naturalAccountCode: string,
  targetPeriodYear: number,
): MappingMemoryRecord | null {
  const candidates = records.filter(
    (r) => r.naturalAccountCode === naturalAccountCode && r.effectivePeriodYear === targetPeriodYear,
  );
  return selectAuthoritativeMapping(candidates);
}

// ════════════════════════════════════════════════════════════════════════════
// Ω∞ PHASE 8 — resolveMappingMemorySuggestion
//
// Answers: "may a PRIOR professional decision in account_review_decisions
// become a CURRENT machine suggestion?" — the only table with real
// historical data today (account_mapping_memory above exists but has
// never been written to by anything). Pure, READ ONLY. Never queries
// Supabase, never calls resolve_account_review_batch, never writes
// account_mappings / account_mapping_memory / account_review_decisions.
// Output is evidence only, feeding Account Review draft state (Phase 6) —
// an explicit professional Save remains the only path to authority.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Three-state provenance strength for a fact this resolver did NOT
 * establish itself. DIRECT = the caller proved the fact was actually
 * recorded at decision time (e.g. from a future account_mapping_memory
 * row, which does carry reportingFramework/sourceSystem columns). Never
 * inferred from account_review_decisions today, which stores neither —
 * see CORRELATED_ONLY. CORRELATED_ONLY = the caller can only offer a
 * present-day proxy (e.g. companies.reporting_framework's CURRENT value)
 * that was not itself stamped on the historical decision — genuinely
 * weaker evidence, never promoted to DIRECT. UNAVAILABLE = the caller has
 * nothing at all for this dimension.
 */
export type ProvenanceStatus = "DIRECT" | "CORRELATED_ONLY" | "UNAVAILABLE";

/**
 * What a historical decision's upload can truthfully be said to relate
 * to, per Gate 0's finding that resolve_account_review_batch performs NO
 * tb_certifications check at save time. This is a claim about the
 * UPLOAD, never about the decision itself — "the decision was itself
 * certified" is not a state this vocabulary can express, deliberately.
 */
export type CertificationRelationship =
  | "LINKED_TO_CERTIFIED_UPLOAD"
  | "LINKED_TO_UNCERTIFIED_UPLOAD"
  | "UNKNOWN";

/**
 * The smallest pure fact set this resolver needs about ONE historical
 * account_review_decisions row (or, once a future slice populates it, an
 * account_mapping_memory row — decisionKind distinguishes the two: only
 * account_mapping_memory rows can ever be "MACHINE_RULE", since
 * account_review_decisions.decision_action's own CHECK constraint only
 * ever admits USER_ACCEPTED_SUGGESTION / USER_MANUAL_CLASSIFICATION /
 * MARK_NON_REPORTING_ACCOUNT — every row in that table already IS a
 * professional act by construction) to safely judge whether it may
 * become PRIOR_PROFESSIONAL_CONFIRMATION evidence for a CURRENT
 * suggestion.
 *
 * Every provenance field here is a fact the CALLER already established —
 * e.g. periodYear by joining upload_id -> trial_balance_uploads.
 * period_year; certificationRelationship by checking tb_certifications
 * the same upload-identity-bound way computeCertificationReadiness.ts
 * already does. A fact the caller could not establish is never
 * defaulted — it is explicitly null/"UNAVAILABLE", never guessed.
 */
export interface HistoricalDecisionContext {
  companyId: string;
  uploadId: string;
  /** From upload_id -> trial_balance_uploads.period_year. Null = could not be established; never guessed from a timestamp. */
  periodYear: number | null;
  /** account_review_decisions.review_account_key — exact identity only, computed server-side; never recomputed or fuzzed here. */
  reviewAccountKey: string;
  /** account_review_decisions.sequence_no — the sole ordering authority; a single global monotonic sequence, never a timestamp. */
  sequenceNo: number;
  decisionAction: "USER_ACCEPTED_SUGGESTION" | "USER_MANUAL_CLASSIFICATION" | "MARK_NON_REPORTING_ACCOUNT";
  proposalType: "NONE" | "MACHINE_SUGGESTION" | "AUTO_MAPPED_RULE";
  /** Present for a classification decision; absent for MARK_NON_REPORTING_ACCOUNT. */
  classification?: string;
  /** Present only when sourced from account_mapping_memory-shaped evidence; absent (never "MACHINE_RULE") for account_review_decisions rows. */
  decisionKind?: DecisionKind;
  ruleId?: string;
  ruleVersion?: string;
  firmMemberId?: string;
  frameworkProvenance: ProvenanceStatus;
  /** Meaningful only when frameworkProvenance !== "UNAVAILABLE". */
  reportingFramework?: ReportingFramework;
  sourceSystemProvenance: ProvenanceStatus;
  /** Meaningful only when sourceSystemProvenance !== "UNAVAILABLE". */
  sourceSystem?: SourceSystem;
  certificationRelationship: CertificationRelationship;
}

export interface MappingMemoryQuery {
  companyId: string;
  reviewAccountKey: string;
  /** The framework the CURRENT period is confirmed under — caller-resolved (e.g. entityContext.ts); never guessed by this resolver. */
  targetReportingFramework: ReportingFramework;
  targetSourceSystem: SourceSystem;
  /**
   * A stronger CURRENT signal (e.g. a Tier-2 exact-code rule match) this
   * resolver must never silently override — reuses ClassificationOutcome's
   * own conflicts: string[] shape. Phase 3 precedence is not changed here;
   * this resolver only surfaces the conflict, never resolves it.
   */
  conflictingCurrentEvidence?: { description: string }[];
}

export type MappingMemoryResultKind =
  | "SUGGESTION_ELIGIBLE"
  | "NO_HISTORY"
  | "NOT_PROFESSIONALLY_DECIDED"
  | "PERIOD_UNAVAILABLE"
  | "FRAMEWORK_INCOMPATIBLE"
  | "SOURCE_SYSTEM_INCOMPATIBLE"
  | "AMBIGUOUS_EQUAL_AUTHORITY";

export interface MappingMemorySuggestion {
  reviewAccountKey: string;
  result: MappingMemoryResultKind;
  reason: string;
  /** Present only when result === "SUGGESTION_ELIGIBLE" and the historical decision was a classification. */
  suggestedClassification?: string;
  /** True only when the historical decision itself was MARK_NON_REPORTING_ACCOUNT — a suggestion only, never an automatic exclusion (§14). */
  suggestsNonReporting?: boolean;
  confidenceSource?: "PRIOR_PROFESSIONAL_CONFIRMATION";
  confidence?: ConfidenceLevel;
  sourcePeriodYear?: number;
  sourceSequenceNo?: number;
  sourceUploadId?: string;
  ruleId?: string;
  ruleVersion?: string;
  frameworkProvenance?: ProvenanceStatus;
  sourceSystemProvenance?: ProvenanceStatus;
  /** Never claims the DECISION was certified — only ever describes the upload it belongs to. */
  certificationRelationship?: CertificationRelationship;
  /** Echoed verbatim from query.conflictingCurrentEvidence — never auto-resolved. */
  conflicts: string[];
}

const CONFIDENCE_ORDER: ConfidenceLevel[] = ["NONE", "LOW", "MEDIUM", "HIGH"];

/** The weaker of two confidence levels — a suggestion is only as strong as its weakest-provenanced dimension. */
function weakerConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return CONFIDENCE_ORDER.indexOf(a) <= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

/**
 * Resolves whether prior professional decisions for ONE account identity
 * may become a current machine suggestion. Deterministic: highest
 * sequence_no wins (a total order by construction — sequence_no is a
 * single global Postgres sequence); a duplicate sequence_no in the input
 * is malformed data, never resolved by array order, and fails closed to
 * AMBIGUOUS_EQUAL_AUTHORITY instead. Fails closed at every boundary —
 * never converts an absent fact into approval, a fabricated classification,
 * or a confidence score invented beyond the existing HIGH/MEDIUM/LOW/NONE
 * vocabulary.
 */
export function resolveMappingMemorySuggestion(
  history: HistoricalDecisionContext[],
  query: MappingMemoryQuery,
): MappingMemorySuggestion {
  // Company isolation — defensive, never trusts the caller/RLS alone.
  const sameCompany = history.filter((h) => h.companyId === query.companyId);
  // Exact account identity only — no fuzzy/lexical matching in this resolver.
  const sameAccount = sameCompany.filter((h) => h.reviewAccountKey === query.reviewAccountKey);

  if (sameAccount.length === 0) {
    return {
      reviewAccountKey: query.reviewAccountKey,
      result: "NO_HISTORY",
      reason: "No historical decision found for this company and exact account identity.",
      conflicts: [],
    };
  }

  // A MACHINE_RULE-tagged record (only reachable via account_mapping_memory-
  // shaped evidence) never represents a professional act. proposal_type
  // alone never qualifies either — decisionAction is what proves the act.
  const professionalActs = sameAccount.filter((h) => h.decisionKind !== "MACHINE_RULE");
  if (professionalActs.length === 0) {
    return {
      reviewAccountKey: query.reviewAccountKey,
      result: "NOT_PROFESSIONALLY_DECIDED",
      reason: "Historical records exist for this account, but none represent a genuine professional act — machine-only evidence cannot become PRIOR_PROFESSIONAL_CONFIRMATION.",
      conflicts: [],
    };
  }

  const maxSeq = Math.max(...professionalActs.map((h) => h.sequenceNo));
  const winners = professionalActs.filter((h) => h.sequenceNo === maxSeq);
  if (winners.length > 1) {
    return {
      reviewAccountKey: query.reviewAccountKey,
      result: "AMBIGUOUS_EQUAL_AUTHORITY",
      reason: `${winners.length} historical records share sequence_no ${maxSeq} — sequence_no is a total order by construction; this input cannot be resolved deterministically and is not guessed.`,
      conflicts: [],
    };
  }
  const latest = winners[0];

  if (latest.periodYear === null) {
    return {
      reviewAccountKey: query.reviewAccountKey,
      result: "PERIOD_UNAVAILABLE",
      reason: "The latest professional decision's historical period could not be established by the caller (no upload -> period_year link supplied) — never guessed from a timestamp or defaulted.",
      conflicts: [],
    };
  }

  let frameworkConfidence: ConfidenceLevel = "HIGH";
  if (latest.frameworkProvenance === "DIRECT") {
    if (latest.reportingFramework !== query.targetReportingFramework) {
      return {
        reviewAccountKey: query.reviewAccountKey,
        result: "FRAMEWORK_INCOMPATIBLE",
        reason: `Historical decision's directly-provenanced framework (${latest.reportingFramework}) does not match the target framework (${query.targetReportingFramework}).`,
        conflicts: [],
      };
    }
  } else if (latest.frameworkProvenance === "CORRELATED_ONLY") {
    frameworkConfidence = "MEDIUM";
  } else {
    frameworkConfidence = "LOW";
  }

  let sourceSystemConfidence: ConfidenceLevel = "HIGH";
  if (latest.sourceSystemProvenance === "DIRECT") {
    if (latest.sourceSystem !== query.targetSourceSystem) {
      return {
        reviewAccountKey: query.reviewAccountKey,
        result: "SOURCE_SYSTEM_INCOMPATIBLE",
        reason: `Historical decision's directly-provenanced source system (${latest.sourceSystem}) does not match the target source system (${query.targetSourceSystem}).`,
        conflicts: [],
      };
    }
  } else if (latest.sourceSystemProvenance === "CORRELATED_ONLY") {
    sourceSystemConfidence = "MEDIUM";
  } else {
    sourceSystemConfidence = "LOW";
  }

  const confidence = weakerConfidence(frameworkConfidence, sourceSystemConfidence);
  const isNonReporting = latest.decisionAction === "MARK_NON_REPORTING_ACCOUNT";
  const conflicts = (query.conflictingCurrentEvidence ?? []).map((c) => c.description);

  return {
    reviewAccountKey: query.reviewAccountKey,
    result: "SUGGESTION_ELIGIBLE",
    reason: isNonReporting
      ? `Historical decision (period ${latest.periodYear}) marked this account non-reporting — presented as a suggestion only, never an automatic exclusion.`
      : `Historical decision (period ${latest.periodYear}) classified this account as "${latest.classification}".`,
    suggestedClassification: isNonReporting ? undefined : latest.classification,
    suggestsNonReporting: isNonReporting || undefined,
    confidenceSource: "PRIOR_PROFESSIONAL_CONFIRMATION",
    confidence,
    sourcePeriodYear: latest.periodYear,
    sourceSequenceNo: latest.sequenceNo,
    sourceUploadId: latest.uploadId,
    ruleId: latest.ruleId,
    ruleVersion: latest.ruleVersion,
    frameworkProvenance: latest.frameworkProvenance,
    sourceSystemProvenance: latest.sourceSystemProvenance,
    certificationRelationship: latest.certificationRelationship,
    conflicts,
  };
}
