/**
 * EntityAccountingContext — pure conceptual contracts.
 * Ω∞ public-sector / framework intelligence engine — Slice 1.
 *
 * Pure type definitions only — no side effects, no Supabase imports, no DB
 * reads/writes. Nothing in the app imports this yet.
 *
 * Reporting framework, accounting basis, entity class, ownership, and source
 * system are independent (orthogonal) dimensions (directive C1/C2/C7) — never
 * collapse them into one field, and never let one determine another:
 *   government-owned  != IPSAS
 *   NGO                != IPSAS
 *   QuickBooks          != IFRS
 * That inference logic does not exist yet — it lands in Slice 2 (read-only
 * detection) and must always produce a Provenance<T>, never a bare guess.
 */

// ── Entity classification ────────────────────────────────────────────────────

export type EntityClass =
  | "LOCAL_GOVERNMENT"
  | "CENTRAL_GOVERNMENT"
  | "PUBLIC_AGENCY"
  | "REGULATORY_AUTHORITY"
  | "PUBLIC_EDUCATION_BODY"
  | "STATE_OWNED_COMMERCIAL_ENTERPRISE"
  | "NONPROFIT_NGO"
  | "COMMUNITY_BASED_ORGANISATION"
  | "PRIVATE_COMPANY"
  | "OTHER"
  | "UNKNOWN";

/**
 * Ownership is a SEPARATE dimension from entityClass and reportingFramework.
 * A STATE_OWNED_COMMERCIAL_ENTERPRISE is government-owned but may report
 * under IFRS (the ATCL case) — ownership never determines framework (C1).
 */
export type OwnershipClass =
  | "GOVERNMENT_OWNED"
  | "PRIVATELY_OWNED"
  | "MIXED_OWNERSHIP"
  | "MEMBER_OWNED"
  | "UNKNOWN";

// ── Reporting framework / accounting basis (C2: orthogonal to source system) ─

/**
 * NOTE on 'ipsas_cash': the legacy `companies.reporting_framework` DB column
 * (CHECK-constrained) has a 4th value, 'ipsas_cash', with no dedicated entry
 * here — the directive's Section III only names IPSAS_ACCRUAL. It is
 * presently disabled/unselectable in CompanyManager.tsx ("coming soon"), so
 * no live company relies on it (PHASE-0 audit §2). See frameworkAdapter.ts
 * for the explicit, documented mapping decision — it is NOT silently dropped.
 */
export type ReportingFramework =
  | "IPSAS_ACCRUAL"
  | "IFRS"
  | "IFRS_FOR_SMES"
  | "OTHER_CONFIRMED"
  | "UNKNOWN";

export type AccountingBasis =
  | "ACCRUAL"
  | "CASH"
  | "MODIFIED_OR_OTHER"
  | "UNKNOWN";

// ── Source system (C2: describes SOURCE, never presentation) ────────────────

export type SourceSystem =
  | "MUSE"
  | "GACS"
  | "QUICKBOOKS"
  | "SAGE"
  | "EXCEL"
  | "OTHER_ERP"
  | "UNKNOWN";

// ── Provenance (C8: framework/context certainty must be explainable) ────────

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/**
 * Evidence precedence, highest first (directive Section III). Only
 * DOCUMENTED_COMPLIANCE_STATEMENT and PRIOR_PROFESSIONAL_CONFIRMATION are
 * strong enough to auto-establish a value without asking — everything below
 * SOURCE_SYSTEM_SIGNATURE should normally accompany confidence <= MEDIUM.
 * (Enforcing that pairing is Slice 2's job; this module only models the shape.)
 */
export type EvidenceSource =
  | "DOCUMENTED_COMPLIANCE_STATEMENT" // explicit statement in uploaded audited FS
  | "PRIOR_PROFESSIONAL_CONFIRMATION" // previously confirmed by a CPA on this entity
  | "CONFIGURED_ENGAGEMENT_CONTEXT"   // authoritative engagement setup
  | "SOURCE_SYSTEM_SIGNATURE"         // strong source-system/account-code match
  | "LEGAL_FORM_EVIDENCE"             // organisation/legal-form evidence
  | "LEXICAL_SIGNAL"                  // account-name/keyword evidence only
  | "USER_MANUAL_ENTRY"               // preparer typed/selected it directly
  | "UNKNOWN";

/** A single piece of evidence contributing to a Provenance<T> determination. */
export interface EvidenceItem {
  source: EvidenceSource;
  detail: string;
  /** Free-text or record id pointing at what produced this evidence. */
  ref?: string;
}

/**
 * Wraps any inferred/confirmed value with full provenance (C8). A
 * Provenance<T> must never be collapsed down to just `value` in any UI or
 * downstream consumer — confidence and evidence travel with it, always.
 */
export interface Provenance<T> {
  value: T;
  confidence: ConfidenceLevel;
  /** Highest-precedence evidence item that produced `value`. */
  source: EvidenceSource;
  evidence: EvidenceItem[];
  confirmedBy?: string; // firm_members.id of the CPA who confirmed it
  confirmedAt?: string; // ISO timestamp of confirmation
}

/** An UNKNOWN, unconfirmed Provenance<T> — the safe default. Never guess (C4). */
export function unknownProvenance<T>(unknownValue: T): Provenance<T> {
  return {
    value: unknownValue,
    confidence: "NONE",
    source: "UNKNOWN",
    evidence: [],
  };
}

// ── The composed context ─────────────────────────────────────────────────────

/**
 * Jurisdiction is free-form for now (e.g. "TZ") — no jurisdiction registry
 * exists yet (out of Slice 1 scope). Widen to a proper enum/registry only
 * when a second jurisdiction is actually onboarded.
 */
export type Jurisdiction = string;

/**
 * EntityAccountingContext — directive Section III, refined per C8: every
 * framework-adjacent field carries its OWN Provenance<T> (not just framework
 * and source system as the directive's illustrative sketch implies) so no
 * downstream consumer can present an inferred entityClass or ownershipClass
 * as though it were professionally confirmed either.
 */
export interface EntityAccountingContext {
  jurisdiction: Jurisdiction;
  entityClass: Provenance<EntityClass>;
  ownershipClass: Provenance<OwnershipClass>;
  reportingFramework: Provenance<ReportingFramework>;
  accountingBasis: Provenance<AccountingBasis>;
  sourceSystem: Provenance<SourceSystem>;
}

/** The fully-unknown context — the safe default before any evidence exists. */
export function emptyEntityAccountingContext(
  jurisdiction: Jurisdiction = "UNKNOWN",
): EntityAccountingContext {
  return {
    jurisdiction,
    entityClass: unknownProvenance<EntityClass>("UNKNOWN"),
    ownershipClass: unknownProvenance<OwnershipClass>("UNKNOWN"),
    reportingFramework: unknownProvenance<ReportingFramework>("UNKNOWN"),
    accountingBasis: unknownProvenance<AccountingBasis>("UNKNOWN"),
    sourceSystem: unknownProvenance<SourceSystem>("UNKNOWN"),
  };
}
