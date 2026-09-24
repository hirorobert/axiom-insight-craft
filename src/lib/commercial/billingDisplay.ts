import { displayCataloguePlanName } from "@/lib/commercial/pricingCatalogue";
import type { LicenceStatus } from "@/lib/commercial/entitlementContract";
import { isFeatureCode, FEATURE_DESCRIPTIONS } from "@/lib/commercial/featureRegistry";

/**
 * Pure Settings "Plan & Billing" display-mapping functions, extracted out
 * of Settings.tsx so they can be unit-tested directly (importing the page
 * component itself would pull in React Router, the Supabase client, and
 * other module-scope side effects that have no place in a logic test).
 *
 * The authoritative plan-code vocabulary is FREE, PRACTICE, FIRM, ENTERPRISE and
 * the grandfathered legacy PAID (commercial_plans.code, 20260925100000). Anything else
 * — a future code the UI doesn't know about yet, or a data-integrity
 * issue — fails closed rather than being misrepresented as an active paid
 * plan (CFOClose Ω∞ Execution Charter, Phase 1, item 5).
 *
 * IMPORTANT: this function does NOT decide what to show when there is no
 * billing customer at all — that is a separate, distinct state, and
 * Settings.tsx's own `!billing.hasBillingCustomer` branch renders the
 * default Free state for it upstream of this call. By the time
 * `displayPlanName` is invoked, a billing customer is already confirmed to
 * exist, so a `null` or empty `planCode` reaching here is itself an
 * anomaly — not "no billing customer" — and must fail closed exactly like
 * any other unrecognized code.
 */
export function displayPlanName(planCode: string | null): string {
  return displayCataloguePlanName(planCode) ?? "Plan unavailable";
}

/**
 * Fallback for an entitlement code outside the known feature registry
 * (charter item 6). Must never expose the raw code and must never claim
 * or imply the capability is included — an unrecognized code might not
 * be a real, currently-included capability at all (a stale code, a typo,
 * a future code this build doesn't know about yet), so describing it as
 * "included with your plan" would overclaim. States only that details are
 * unavailable.
 */
export const UNKNOWN_ENTITLEMENT_LABEL = "Capability details unavailable";

/** Maps a server entitlement code to its customer-facing description, never the raw code. */
export function displayEntitlement(code: string): string {
  return isFeatureCode(code) ? FEATURE_DESCRIPTIONS[code] : UNKNOWN_ENTITLEMENT_LABEL;
}

const LICENCE_STATUS_LABELS: Record<LicenceStatus, string> = {
  PENDING: "Pending",
  ACTIVE: "Active",
  GRACE: "Grace period",
  EXPIRED: "Expired",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
};

/**
 * Maps a licence status to its customer-facing label. Fails closed: the
 * `LicenceStatus` type promises only the six known values, but a runtime
 * value can still deviate from that promise (an untyped RPC response, a
 * future server-side status this build doesn't know about yet, or a
 * malformed payload) — such a value must never be echoed back to the
 * customer verbatim.
 */
export function displayLicenceStatus(status: LicenceStatus | null): string {
  if (!status) return "Unknown";
  return LICENCE_STATUS_LABELS[status] ?? "Status unavailable";
}

export function licenceBadgeVariant(
  status: LicenceStatus | null,
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "ACTIVE") return "default";
  if (status === "GRACE") return "secondary";
  if (status === "EXPIRED") return "destructive";
  if (status === "SUSPENDED") return "destructive";
  if (status === "CANCELLED") return "destructive";
  return "outline";
}

/** Label for a licence's effective-through date (charter item 7 — never "Renews"). */
export const EFFECTIVE_END_LABEL = "Effective through";

/** Unambiguous, timezone-stable customer-facing licence date. */
export function formatLicenceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
