/**
 * Ω1 — pure TS mirror of the server-authoritative entitlement resolution
 * logic in _resolve_entitlement_for_owner() (migration
 * 20260904180000_commercial_foundation_wave_omega1.sql).
 *
 * NON-AUTHORITATIVE. This module never grants or denies anything by
 * itself — it exists so the UI can render a consistent "why is this
 * locked" explanation from data already returned by a server call
 * (get_effective_entitlement / get_my_billing_summary), without a second
 * round trip, and so the classification rules are unit-testable in an
 * environment with no live database. The real gate is always the server:
 * get_effective_entitlement() for a specific company+feature, or the
 * relevant Edge Function / RPC / trigger for a specific write. Any client
 * that bypasses the server call (direct REST, localStorage, URL edits)
 * gains nothing — there is no premium behavior gated on this module alone.
 *
 * UNKNOWN != NOT_ENTITLED != ENTITLED. Every caller of this module and of
 * the server RPCs it mirrors must fail closed: treat UNKNOWN the same as
 * NOT_ENTITLED for any privileged action, while still surfacing UNKNOWN as
 * a distinct diagnostic to the user/operator rather than silently
 * flattening it to false.
 */

import { FEATURE_CODES, type FeatureCode, isFeatureCode } from "./featureRegistry";

export type EntitlementStatus = "ENTITLED" | "NOT_ENTITLED" | "UNKNOWN";

export type LicenceStatus =
  | "PENDING"
  | "ACTIVE"
  | "GRACE"
  | "SUSPENDED"
  | "CANCELLED"
  | "EXPIRED";

export const LICENCE_STATUSES: readonly LicenceStatus[] = [
  "PENDING",
  "ACTIVE",
  "GRACE",
  "SUSPENDED",
  "CANCELLED",
  "EXPIRED",
];

/** Licence statuses under which entitlement can be granted (flagged design decision (c): GRACE == entitled). */
const ENTITLING_LICENCE_STATUSES: readonly LicenceStatus[] = ["ACTIVE", "GRACE"];

export interface EntitlementResult {
  status: EntitlementStatus;
  reason: string;
  licenceStatus: LicenceStatus | null;
  planCode: string | null;
  source: "ACTIVE_LICENCE" | "ADMIN_OVERRIDE" | null;
}

export interface CurrentLicenceSnapshot {
  status: LicenceStatus;
  planCode: string;
  featureCodes: readonly string[];
}

/**
 * Mirrors _resolve_entitlement_for_owner()'s decision tree exactly. Given
 * already-fetched licence + override state (as returned by a server RPC),
 * classifies the effective entitlement for one feature.
 *
 * @param hasBillingCustomer whether a billing_customers row exists for the owner
 * @param currentLicence the licence period covering "now", if any (null if none is current)
 * @param hasActiveOverride whether an active, unrevoked entitlement_overrides row exists for this feature
 */
export function classifyEntitlement(
  featureCode: string,
  hasBillingCustomer: boolean,
  currentLicence: CurrentLicenceSnapshot | null,
  hasActiveOverride: boolean,
): EntitlementResult {
  if (!isFeatureCode(featureCode)) {
    return { status: "UNKNOWN", reason: "UNKNOWN_FEATURE_CODE", licenceStatus: null, planCode: null, source: null };
  }

  if (!hasBillingCustomer) {
    return { status: "NOT_ENTITLED", reason: "NO_BILLING_CUSTOMER", licenceStatus: null, planCode: null, source: null };
  }

  if (hasActiveOverride) {
    return { status: "ENTITLED", reason: "ADMIN_OVERRIDE_ACTIVE", licenceStatus: null, planCode: null, source: "ADMIN_OVERRIDE" };
  }

  if (!currentLicence) {
    return { status: "NOT_ENTITLED", reason: "NO_CURRENT_LICENCE_PERIOD", licenceStatus: null, planCode: null, source: null };
  }

  if (!ENTITLING_LICENCE_STATUSES.includes(currentLicence.status)) {
    return {
      status: "NOT_ENTITLED",
      reason: "LICENCE_NOT_ACTIVE",
      licenceStatus: currentLicence.status,
      planCode: currentLicence.planCode,
      source: null,
    };
  }

  if (currentLicence.featureCodes.includes(featureCode)) {
    return {
      status: "ENTITLED",
      reason: "ACTIVE_LICENCE_INCLUDES_FEATURE",
      licenceStatus: currentLicence.status,
      planCode: currentLicence.planCode,
      source: "ACTIVE_LICENCE",
    };
  }

  return {
    status: "NOT_ENTITLED",
    reason: "PLAN_DOES_NOT_INCLUDE_FEATURE",
    licenceStatus: currentLicence.status,
    planCode: currentLicence.planCode,
    source: null,
  };
}

/** UNKNOWN and NOT_ENTITLED both fail closed for privileged use — ENTITLED is the only pass state. */
export function isEntitledForPrivilegedUse(result: EntitlementResult): boolean {
  return result.status === "ENTITLED";
}

// ─────────────────────────────────────────────────────────────────────────
// Licence-period selection — pure mirror of the query inside
// _resolve_entitlement_for_owner() and of the invariant enforced by
// excl_cl_no_overlapping_authoritative_periods (a PostgreSQL EXCLUDE USING
// gist constraint, see the migration). NON-AUTHORITATIVE: the real
// overlap-prevention lives in Postgres and cannot be exercised by a unit
// test in this environment (no live database). This mirror exists so the
// SELECTION logic — "given a valid, non-overlapping set of authoritative
// periods, which one is current right now" — is unit-tested, and so the
// invariant's own overlap semantics are documented and checkable in TS.
// ─────────────────────────────────────────────────────────────────────────

export interface LicencePeriod {
  id: string;
  status: LicenceStatus;
  planCode: string;
  featureCodes: readonly string[];
  effectiveStart: Date;
  /** null = open-ended (unbounded upper range bound, matching tstzrange(start, NULL)). */
  effectiveEnd: Date | null;
}

/** Half-open [start, end) overlap test, matching tstzrange(..., '[)'). */
function rangesOverlap(
  aStart: Date,
  aEnd: Date | null,
  bStart: Date,
  bEnd: Date | null,
): boolean {
  const aEndMs = aEnd ? aEnd.getTime() : Infinity;
  const bEndMs = bEnd ? bEnd.getTime() : Infinity;
  return aStart.getTime() < bEndMs && bStart.getTime() < aEndMs;
}

export function periodsOverlap(a: LicencePeriod, b: LicencePeriod): boolean {
  return rangesOverlap(a.effectiveStart, a.effectiveEnd, b.effectiveStart, b.effectiveEnd);
}

/**
 * Mirrors excl_cl_no_overlapping_authoritative_periods: true if `candidate`
 * coexisting with `existing` would violate the DB invariant (both
 * ACTIVE/GRACE and overlapping in time). Documents the invariant's logic
 * for testing — the real enforcement is the Postgres EXCLUDE constraint on
 * commercial_licences, not this function.
 */
export function wouldViolateLicenceAuthorityInvariant(
  candidate: LicencePeriod,
  existing: readonly LicencePeriod[],
): boolean {
  if (!ENTITLING_LICENCE_STATUSES.includes(candidate.status)) return false;
  return existing.some(
    (p) =>
      p.id !== candidate.id &&
      ENTITLING_LICENCE_STATUSES.includes(p.status) &&
      periodsOverlap(candidate, p),
  );
}

/**
 * Mirrors the resolver's own query: among ACTIVE/GRACE periods whose
 * [effectiveStart, effectiveEnd) window contains `now`, pick the current
 * one. For a VALID input (one that satisfies
 * excl_cl_no_overlapping_authoritative_periods, i.e. no two ACTIVE/GRACE
 * periods here overlap each other), there is provably at most one
 * candidate — the sort is defense-in-depth, not a tie-break relied upon in
 * practice. PENDING/SUSPENDED/CANCELLED/EXPIRED periods never participate,
 * regardless of their dates.
 */
export function selectCurrentAuthoritativeLicence(
  periods: readonly LicencePeriod[],
  now: Date,
): LicencePeriod | null {
  const nowMs = now.getTime();
  const candidates = periods.filter(
    (p) =>
      ENTITLING_LICENCE_STATUSES.includes(p.status) &&
      p.effectiveStart.getTime() <= nowMs &&
      (p.effectiveEnd === null || p.effectiveEnd.getTime() > nowMs),
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.effectiveStart.getTime() - a.effectiveStart.getTime())[0];
}

export { FEATURE_CODES };
export type { FeatureCode };
