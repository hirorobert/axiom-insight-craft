/**
 * Pure rules of the signed-in purchase journey (owner review 2026-10-20), shared by the plan chip, the plans page and the
 * unfinished-checkout controls. No I/O, no React.
 */
import type { BillingSummary } from "@/hooks/useBillingSummary";
import { displayCataloguePlanName, type PlanCode } from "@/lib/commercial/pricingCatalogue";
import { hasCurrentPlan } from "@/lib/workspace/accountNextAction";

// ── Plan groups (two tabs, two cards each) ───────────────────────────────────────────────────────────────────────────
export type PlanGroup = "small" | "firms";
export const PLAN_GROUPS: readonly { readonly id: PlanGroup; readonly label: string; readonly plans: readonly PlanCode[] }[] = [
  { id: "small", label: "Small practices", plans: ["SOLO", "PRACTICE"] },
  { id: "firms", label: "Firms", plans: ["FIRM", "ENTERPRISE"] },
];

// ── The header plan chip ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * "No plan · Choose a plan", "<Plan> plan", or "Plan expired · Renew" — read from the caller's own billing account. It never
 * claims a state it does not know (NULL is not computed): while loading, on a read error, for a person who holds no billing
 * account (a team member of another account), or for a pending/suspended licence it is "none". There is no free plan.
 */
export type PlanChipView =
  | { kind: "none" }
  | { kind: "no_plan"; label: string; action: string; href: string }
  | { kind: "current"; label: string }
  | { kind: "expired"; label: string; action: string; href: string };

export function planChipView(summary: BillingSummary | null, loading: boolean, error: string | null): PlanChipView {
  if (loading || error || !summary || !summary.hasBillingCustomer) return { kind: "none" };
  if (hasCurrentPlan(summary)) {
    const name = displayCataloguePlanName(summary.planCode);
    return name ? { kind: "current", label: `${name} plan` } : { kind: "none" };
  }
  if (summary.licenceStatus === "EXPIRED") return { kind: "expired", label: "Plan expired", action: "Renew", href: "/plans" };
  if (summary.licenceStatus === null || summary.licenceStatus === "CANCELLED") return { kind: "no_plan", label: "No plan", action: "Choose a plan", href: "/plans" };
  return { kind: "none" };
}

// ── Leaving an unfinished checkout (20261119100000) ──────────────────────────────────────────────────────────────────
/** The consequence, stated once before the customer confirms (a commercial-policy change — see LeaveCheckout). */
export const LEAVE_CHECKOUT_DISCLOSURE =
  "This closes the checkout in CFOClose so you can choose another plan. The payment page itself stays open until it expires — don't pay on it. " +
  "If it is paid anyway, the payment is recorded and never applied twice: our team reviews it and refunds it, or adds the time with your agreement.";

/** A resume page address the browser may open: the provider's https page (a loopback page only in local sandbox tests —
 *  the server never returns one in production; the same rule as the checkout page's redirect). */
export function safeResumeUrl(url: string | null | undefined): string | null {
  return url && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)/.test(url) ? url : null;
}
