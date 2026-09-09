import { PRICING } from "@/constants/copy";
import type { LicenceStatus } from "@/lib/commercial/entitlementContract";
import { isFeatureCode, FEATURE_DESCRIPTIONS } from "@/lib/commercial/featureRegistry";

/**
 * Pure Settings "Plan & Billing" display-mapping functions, extracted out
 * of Settings.tsx so they can be unit-tested directly (importing the page
 * component itself would pull in React Router, the Supabase client, and
 * other module-scope side effects that have no place in a logic test).
 *
 * The authoritative plan-code vocabulary today is exactly "FREE" and
 * "PAID" (commercial_plans.code, Ω1 commercial foundation). Anything else
 * — a future code the UI doesn't know about yet, or a data-integrity
 * issue — fails closed rather than being misrepresented as an active paid
 * plan (CFOClose Ω∞ Execution Charter, Phase 1, item 5).
 */
export function displayPlanName(planCode: string | null): string {
  if (!planCode) return PRICING.FREE_NAME;
  if (planCode === "FREE") return PRICING.FREE_NAME;
  if (planCode === "PAID") return PRICING.PAID_NAME;
  return "Plan unavailable";
}

/** Generic, non-identifying fallback for an entitlement code outside the known feature registry (charter item 6). */
export const UNKNOWN_ENTITLEMENT_LABEL = "Additional capability included with your plan";

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

/** Maps a licence status to its customer-facing label. Falls back to the raw status only if a future status is added here before its label is. */
export function displayLicenceStatus(status: LicenceStatus | null): string {
  if (!status) return "Unknown";
  return LICENCE_STATUS_LABELS[status] ?? status;
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
