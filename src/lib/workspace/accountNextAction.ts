/**
 * accountNextAction — the ONE primary next action of the account home (/dashboard when it shows the hub), derived
 * from authoritative reads only:
 *   - the plan: get_my_billing_summary (useBillingSummary);
 *   - entity capacity: the server's capacity answer (useMyEntityCapacity);
 *   - companies, periods and engagements: useActiveEngagements (fetchWorkspaceSnapshot → deriveWorkspaceState);
 *   - per-company review permission: useReviewActionAccess (my_workspace_capabilities).
 *
 * Pure: no I/O, no clock. It only CHOOSES what to show. Every action it points to is enforced again by the server
 * (create_entity, grant_engagement_capability, RLS), so a changed interface can never grant anything.
 *
 * Precedence: a read in flight → a failed read (retry) → no plan (choose a plan; existing records stay readable)
 * → existing work (resume / choose) → a withheld engagement this person may continue with Trial balance review →
 * a company without an engagement → a shared workspace → adding a company (when capacity permits) → capacity reached.
 */
import type { BillingSummary } from "@/hooks/useBillingSummary";
import type { CapacityAnswer } from "@/lib/commercial/paidActions";
import type { ReviewActionGate } from "./unavailableService";

export type CompanyCreation = "checking" | "unknown" | "needs_plan" | "allowed" | "capacity_reached";

export type AccountNextAction =
  | { kind: "checking"; title: string }
  | { kind: "retry"; title: string; detail: string }
  | { kind: "choose_plan"; title: string; detail: string }
  | { kind: "resume"; title: string; detail: string; engagementId: string }
  | { kind: "choose_engagement"; title: string; detail: string }
  | { kind: "start_review"; title: string; detail: string; engagementId: string }
  | { kind: "start_service"; title: string; detail: string; companyId: string }
  | { kind: "choose_company"; title: string; detail: string }
  | { kind: "open_shared"; title: string; detail: string }
  | { kind: "add_company"; title: string; detail: string }
  | { kind: "capacity_reached"; title: string; detail: string }
  | { kind: "ask_owner"; title: string; detail: string };

export interface AccountNextActionInput {
  billing: { loading: boolean; error: boolean; summary: BillingSummary | null };
  capacity: { loading: boolean; error: boolean; answer: CapacityAnswer | null };
  entries: readonly { engagementId: string; companyName: string; periodYear: number }[];
  unavailable: readonly { engagementId: string; companyId: string; companyName: string; periodYear: number }[];
  reviewGates: Readonly<Record<string, ReviewActionGate | undefined>>;
  companiesWithoutEngagement: readonly { id: string; name: string }[];
  sharedCount: number;
}

export const hasCurrentPlan = (b: BillingSummary | null): boolean => b?.licenceStatus === "ACTIVE" || b?.licenceStatus === "GRACE";

/** Whether the home may offer company creation. The server (create_entity) remains the authority either way. */
export function companyCreation(i: Pick<AccountNextActionInput, "billing" | "capacity">): CompanyCreation {
  if (i.billing.loading || i.capacity.loading) return "checking";
  if (i.billing.error || !i.billing.summary) return "unknown";
  if (!hasCurrentPlan(i.billing.summary)) return "needs_plan";
  const c = i.capacity.answer;
  if (i.capacity.error || !c) return "unknown";
  // Undetermined capacity is the server's answer for "by agreement" plans: offer creation, the server decides.
  if (!c.determined || c.capacity === null) return "allowed";
  if (c.used === null) return "unknown";
  return c.used < c.capacity ? "allowed" : "capacity_reached";
}

const NO_PLAN_KEEPS = "Your companies, engagements and records are kept and stay readable. Starting new work needs an active plan.";

export function deriveAccountNextAction(i: AccountNextActionInput): AccountNextAction {
  if (i.billing.loading) return { kind: "checking", title: "Checking your plan…" };
  if (i.billing.error || !i.billing.summary) {
    return { kind: "retry", title: "We couldn’t confirm your plan", detail: "This is a connection problem, not a change to your account. Try again." };
  }
  const ownWork = i.entries.length + i.unavailable.length + i.companiesWithoutEngagement.length;
  if (!hasCurrentPlan(i.billing.summary)) {
    if (ownWork === 0 && i.sharedCount > 0) {
      return { kind: "open_shared", title: "Open a workspace shared with you", detail: "Access to a shared workspace comes from its owner’s plan. To start work of your own, choose a plan." };
    }
    return {
      kind: "choose_plan",
      title: ownWork > 0 ? "Choose a plan to start new work" : "Choose a plan to begin",
      detail: ownWork > 0 ? NO_PLAN_KEEPS : "A plan sets how many companies you can add. Choose one, or ask us to activate a plan for you; you can then add your first company.",
    };
  }
  if (i.entries.length === 1) {
    const e = i.entries[0];
    return { kind: "resume", title: `Continue ${e.companyName} · FY${e.periodYear}`, detail: "Pick up where the work stopped.", engagementId: e.engagementId };
  }
  if (i.entries.length > 1) return { kind: "choose_engagement", title: "Choose an engagement to continue", detail: "Each open engagement is listed below with its next step." };

  const startable = i.unavailable.filter((u) => i.reviewGates[u.companyId]?.state === "allowed");
  if (startable.length === 1) {
    const u = startable[0];
    return { kind: "start_review", title: `Start Trial balance review for ${u.companyName} · ${u.periodYear}`, detail: "The earlier service is no longer offered. Its records are kept; the review uses the same period.", engagementId: u.engagementId };
  }
  if (startable.length > 1) return { kind: "choose_engagement", title: "Choose a company to continue with Trial balance review", detail: "Each one is listed below." };

  if (i.companiesWithoutEngagement.length === 1) {
    const c = i.companiesWithoutEngagement[0];
    return { kind: "start_service", title: `Start work for ${c.name}`, detail: "Choose the period and the service.", companyId: c.id };
  }
  if (i.companiesWithoutEngagement.length > 1) return { kind: "choose_company", title: "Choose a company to start work", detail: "Your companies without an open engagement are listed below." };

  if (i.unavailable.length > 0) {
    if (i.unavailable.some((u) => !i.reviewGates[u.companyId] || i.reviewGates[u.companyId]?.state === "checking")) return { kind: "checking", title: "Checking your access…" };
    return { kind: "ask_owner", title: "Ask the company’s owner to continue", detail: "Your access doesn’t include starting work for the companies listed below. Their records are kept." };
  }
  if (i.sharedCount > 0) return { kind: "open_shared", title: "Open a workspace shared with you", detail: "It is listed below." };

  const create = companyCreation(i);
  if (create === "allowed") return { kind: "add_company", title: "Add your first company", detail: "Name the company and its reporting period. You can then start a trial balance review." };
  if (create === "capacity_reached") return { kind: "capacity_reached", title: "Your plan’s entity capacity is in use", detail: "Choose a larger plan, or ask us to adjust your agreement." };
  if (create === "checking") return { kind: "checking", title: "Checking your entity capacity…" };
  return { kind: "retry", title: "We couldn’t confirm your entity capacity", detail: "This is a connection problem, not a change to your account. Try again." };
}
