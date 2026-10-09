/**
 * deriveOrientationSummary — pure projection of "where am I, what's done, what's next" for a
 * single workspace: Service, Current stage, Current status, and the last authoritative completed
 * milestone. Reads only workspaceState (deriveWorkspaceState's own output) and the mandate's
 * granted capabilities — invents no second readiness computation, no new DB read.
 *
 * "Current stage" / "Current status" come from workspaceState.nextAction — the same single
 * authority the dominant CTA on WorkspaceOverview already uses, so this strip can never disagree
 * with the CTA beneath it.
 *
 * "Last completed milestone" is the LATEST stage (by canonical STAGE_SEQUENCE order) whose mission
 * status is "passed" or "signed" — i.e. genuinely finished work, never "in_progress"/"ready"/
 * "review_required". null when nothing has completed yet (a brand-new engagement has no milestone
 * to show, and that is not an error).
 */

import { STAGE_SEQUENCE, STAGE_CONFIGS } from "./stageMetadata";
import type { EngagementCapability } from "./mandate";
import { customerCapabilityTitle } from "./mandate";
import { customerVisibleCapabilities, isStageCustomerVisible, TRIAL_BALANCE_REVIEW } from "./moduleAvailability";
import type { WorkspaceState } from "./types";
import { reviewedScope } from "./trialBalanceVerdict";

export interface OrientationMilestone {
  stageLabel: string;
  summary: string;
  at: string | null;
}

export interface OrientationSummary {
  /** Practitioner-facing service names, e.g. "Financial statements, Tax computation". Null when no mandate is declared yet. */
  service: string | null;
  currentStageLabel: string;
  currentStatusLabel: string;
  lastCompletedMilestone: OrientationMilestone | null;
}

const COMPLETED_STATUSES = new Set(["passed", "signed"]);

/** Shown in place of a next action that lies in a stage withheld from customers. */
export const NO_VISIBLE_NEXT_ACTION = "No further action is available in this workspace right now.";

export interface TrialBalanceReviewStep {
  readonly ready: boolean;
  readonly label: string;
  readonly detail: string;
}

/**
 * The trial-balance-review outcome once Prepare has passed (the engine's own next action then lies in a withheld stage).
 * Prepare passes only on a certified trial balance (deriveWorkspaceState PATH 6B; a recorded layer-3 exception is never
 * certified): debit/credit parity and every classification confirmed, which is exactly trialBalanceReadiness — a
 * "Reviewed trial balance", ready for statement preparation, whose statement equation is not exactly verified.
 * Supporting-evidence reconciliation is not part of it and is never claimed here. Null while Prepare has not passed (its
 * own next action applies).
 */
export function trialBalanceReviewStep(state: WorkspaceState): TrialBalanceReviewStep | null {
  const prepare = state.missions.prepare.status;
  if (prepare !== "passed" && prepare !== "signed") return null;
  return {
    ready: true,
    label: TRIAL_BALANCE_REVIEW.ready,
    // The same reading as the checks (readRecordedEquation, carried on the snapshot), so the Overview never says "not
    // exactly verified" where the Trial Balance checks show the equation holding exactly.
    detail: `${reviewedScope(state.statementEquationExact === true)} It is ready for statement preparation. ${TRIAL_BALANCE_REVIEW.notApproval}`,
  };
}

export function deriveOrientationSummary(
  workspaceState: WorkspaceState,
  grantedCapabilities: EngagementCapability[] | null,
): OrientationSummary {
  const visibleServices = grantedCapabilities ? customerVisibleCapabilities(grantedCapabilities) : [];
  const service = visibleServices.length > 0 ? visibleServices.map((c) => customerCapabilityTitle(c)).join(", ") : null;

  // A next action in a stage withheld from customers (moduleAvailability.ts) is never named: the customer's own
  // trial-balance-review step is shown instead.
  const nextVisible = isStageCustomerVisible(workspaceState.nextAction.mission);
  const step = nextVisible ? null : trialBalanceReviewStep(workspaceState);
  const currentStageLabel = nextVisible ? STAGE_CONFIGS[workspaceState.nextAction.mission].label : TRIAL_BALANCE_REVIEW.title;
  const currentStatusLabel = nextVisible ? workspaceState.nextAction.label : step?.label ?? NO_VISIBLE_NEXT_ACTION;

  let lastCompletedMilestone: OrientationMilestone | null = null;
  // Walk from the LAST stage backwards so the most-advanced completed stage wins — a later stage
  // being "passed" is always the more informative milestone than an earlier one.
  for (let i = STAGE_SEQUENCE.length - 1; i >= 0; i--) {
    const slug = STAGE_SEQUENCE[i];
    if (!isStageCustomerVisible(slug)) continue;
    const mission = workspaceState.missions[slug];
    if (COMPLETED_STATUSES.has(mission.status)) {
      lastCompletedMilestone = {
        stageLabel: mission.label,
        summary: mission.summary,
        at: workspaceState.lastUpdatedAt ?? null,
      };
      break;
    }
  }

  return { service, currentStageLabel, currentStatusLabel, lastCompletedMilestone };
}
