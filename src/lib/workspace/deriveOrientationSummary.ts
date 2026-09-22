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
import { capabilityTitle } from "./mandate";
import type { WorkspaceState } from "./types";

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

export function deriveOrientationSummary(
  workspaceState: WorkspaceState,
  grantedCapabilities: EngagementCapability[] | null,
): OrientationSummary {
  const service =
    grantedCapabilities && grantedCapabilities.length > 0
      ? grantedCapabilities.map((c) => capabilityTitle(c)).join(", ")
      : null;

  const currentStageLabel = STAGE_CONFIGS[workspaceState.nextAction.mission].label;
  const currentStatusLabel = workspaceState.nextAction.label;

  let lastCompletedMilestone: OrientationMilestone | null = null;
  // Walk from the LAST stage backwards so the most-advanced completed stage wins — a later stage
  // being "passed" is always the more informative milestone than an earlier one.
  for (let i = STAGE_SEQUENCE.length - 1; i >= 0; i--) {
    const slug = STAGE_SEQUENCE[i];
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
