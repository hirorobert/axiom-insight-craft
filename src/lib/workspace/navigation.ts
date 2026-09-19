/**
 * navigation — workspace navigation derived from the PERSISTED engagement scope. Pure.
 *
 *  - Overview is always present.
 *  - With no scope declared, nothing else is offered — except stages that already carry work (an existing workspace
 *    keeps every route to its work; nothing is hidden).
 *  - With a scope, only the stages the services activate (plus the input-evidence stages they rely on) are listed.
 *  - A locked stage appears only because it is a later dependency inside an active workflow, and it carries the reason
 *    and the action that unlocks it.
 */

import { STAGE_CONFIGS } from "./stageMetadata";
import { stageHasWork, type WorkspaceMissionView } from "./mandate";
import type { WorkspaceMission } from "./types";

export interface NavItem {
  readonly id: "overview" | WorkspaceMission;
  readonly label: string;
  readonly href: string;
  readonly disabled: boolean;
  /** Present only when disabled. */
  readonly reason?: string;
  /** Present only when disabled: what unlocks it. */
  readonly action?: string;
  readonly inputEvidenceOnly: boolean;
}

export function deriveWorkspaceNavigation(input: {
  basePath: string;
  scopeDeclared: boolean;
  missionViews: readonly WorkspaceMissionView[];
}): readonly NavItem[] {
  const items: NavItem[] = [{ id: "overview", label: "Overview", href: input.basePath, disabled: false, inputEvidenceOnly: false }];

  for (const view of input.missionViews) {
    const shown = input.scopeDeclared ? view.visible : stageHasWork(view.workflowStatus);
    if (!shown) continue;
    const cfg = STAGE_CONFIGS[view.stage];
    const locked = view.workflowStatus === "locked";
    items.push({
      id: view.stage,
      label: cfg.label,
      href: `${input.basePath}/${view.stage}`,
      disabled: locked,
      ...(locked ? { reason: "Locked until the earlier stage of this workflow is complete.", action: "Complete the previous stage to unlock it." } : {}),
      inputEvidenceOnly: view.prerequisiteOnly,
    });
  }
  return items;
}
