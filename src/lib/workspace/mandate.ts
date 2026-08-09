/**
 * Engagement mandate projection — pure, no async, no side effects.
 *
 * Two orthogonal dimensions, never collapsed into one enum:
 *
 *   workflowStatus  what the accounting engine says (MissionStatus, untouched)
 *   mandateStatus   what the firm was contractually engaged to perform
 *
 * This module NEVER decides whether a stage may run. `deriveWorkspaceState`
 * owns prerequisites and gates. A capability grant can never satisfy a gate,
 * and a gate can never imply a mandate.
 */

import type { MissionState, MissionStatus, WorkspaceMission } from "./types";
import { STAGE_SEQUENCE } from "./stageMetadata";

export type EngagementCapability =
  | "FINANCIAL_STATEMENTS"
  | "TAX_COMPUTATION"
  | "COMPLIANCE_REVIEW"
  | "FILING_PREPARATION"
  | "MONITORING";

export type EngagementAuthorityType =
  | "SUBMIT_CIT_RETURN"
  | "SUBMIT_VAT_RETURN"
  | "SUBMIT_WHT_RETURN"
  | "SUBMIT_REGULATORY_PACKAGE";

export type MandateStatus = "in_scope" | "out_of_scope";

export const ENGAGEMENT_CAPABILITIES: EngagementCapability[] = [
  "FINANCIAL_STATEMENTS",
  "TAX_COMPUTATION",
  "COMPLIANCE_REVIEW",
  "FILING_PREPARATION",
  "MONITORING",
];

/**
 * Professional outcomes, in the words a practitioner would use when opening a
 * file. There is deliberately NO default selection: a tax-only engagement
 * against already-prepared statements is as legitimate as a statements
 * engagement, so pre-selecting one would be an inference about the mandate.
 */
export const CAPABILITY_OUTCOMES: {
  capability: EngagementCapability;
  title: string;
  description: string;
}[] = [
  {
    capability: "FINANCIAL_STATEMENTS",
    title: "Financial statements",
    description: "Prepare the trial balance and produce the statements for this period.",
  },
  {
    capability: "TAX_COMPUTATION",
    title: "Tax computation",
    description: "Compute the tax position. Source data is available as input evidence.",
  },
  {
    capability: "COMPLIANCE_REVIEW",
    title: "Compliance review",
    description: "Review the file against statutory obligations and raise findings.",
  },
  {
    capability: "FILING_PREPARATION",
    title: "Filing package",
    description: "Assemble the filing package. Submission is a separate authority.",
  },
  {
    capability: "MONITORING",
    title: "Ongoing monitoring",
    description: "Track variances and cash signals across periods.",
  },
];

/**
 * Stages a capability *activates* — the capability owns them.
 * This is not, and must never become, the gate engine.
 */
export const CAPABILITY_ACTIVATES: Record<EngagementCapability, WorkspaceMission[]> = {
  FINANCIAL_STATEMENTS: ["prepare", "reconcile", "statements"],
  TAX_COMPUTATION:      ["tax"],
  COMPLIANCE_REVIEW:    ["compliance"],
  FILING_PREPARATION:   ["filing"],
  MONITORING:           ["monitor"],
};

/**
 * Stages a capability needs as *input evidence* without claiming them as part
 * of the contractual mandate. They are shown so the preparer can inspect the
 * inputs they are relying on; they carry no mandate assertion.
 */
export const CAPABILITY_REQUIRES_EVIDENCE: Record<EngagementCapability, WorkspaceMission[]> = {
  FINANCIAL_STATEMENTS: [],
  TAX_COMPUTATION:      ["prepare", "reconcile", "statements"],
  COMPLIANCE_REVIEW:    ["prepare", "statements"],
  FILING_PREPARATION:   ["compliance"],
  MONITORING:           ["prepare"],
};

/** Effective mandate: the fold result, plus whether a mandate is recorded at all. */
export interface EngagementMandate {
  engagementId: string;
  /** Capabilities whose latest event is GRANT. */
  granted: EngagementCapability[];
}

export interface WorkspaceMissionView {
  stage: WorkspaceMission;
  workflowStatus: MissionStatus;
  mandateStatus: MandateStatus;
  /** Rendered in the active rail. */
  visible: boolean;
  /** Present as input evidence only — no mandate is asserted for this stage. */
  prerequisiteOnly: boolean;
  /** Out of mandate, but completed work exists and must stay reachable read-only. */
  retainedWork: boolean;
  mission: MissionState;
}

/** A stage counts as carrying work when the engine says something happened. */
const WORK_EXISTS: MissionStatus[] = ["in_progress", "review_required", "passed", "signed"];

export function stageHasWork(status: MissionStatus): boolean {
  return WORK_EXISTS.includes(status);
}

/**
 * Compose engine mission state with the mandate. The engine's mission object is
 * never mutated and `not_applicable` keeps its workflow meaning.
 *
 * `mandate === null` means no mandate has been declared for this workspace yet
 * (compatibility route, or engagement not opened). In that case every stage is
 * treated as in scope so nothing is ever hidden on an unknown mandate.
 */
export function projectMandate(
  missions: Record<WorkspaceMission, MissionState>,
  mandate: EngagementMandate | null,
): WorkspaceMissionView[] {
  const activated = new Set<WorkspaceMission>();
  const evidence = new Set<WorkspaceMission>();

  if (mandate) {
    for (const cap of mandate.granted) {
      for (const s of CAPABILITY_ACTIVATES[cap] ?? []) activated.add(s);
      for (const s of CAPABILITY_REQUIRES_EVIDENCE[cap] ?? []) evidence.add(s);
    }
  }

  return STAGE_SEQUENCE.map((stage) => {
    const mission = missions[stage];
    const unknownMandate = mandate === null;
    const inScope = unknownMandate || activated.has(stage);
    const prerequisiteOnly = !inScope && evidence.has(stage);
    const hasWork = stageHasWork(mission.status);

    return {
      stage,
      workflowStatus: mission.status,
      mandateStatus: inScope ? "in_scope" : "out_of_scope",
      visible: inScope || prerequisiteOnly,
      prerequisiteOnly,
      retainedWork: !inScope && !prerequisiteOnly && hasWork,
      mission,
    };
  });
}

/** Convenience lookup for route guards. */
export function findMissionView(
  views: WorkspaceMissionView[],
  stage: WorkspaceMission,
): WorkspaceMissionView | undefined {
  return views.find((v) => v.stage === stage);
}

/** Which capability a stage belongs to — used by the boundary copy. */
export function owningCapability(stage: WorkspaceMission): EngagementCapability | null {
  for (const cap of ENGAGEMENT_CAPABILITIES) {
    if (CAPABILITY_ACTIVATES[cap].includes(stage)) return cap;
  }
  return null;
}

export function capabilityTitle(cap: EngagementCapability): string {
  return CAPABILITY_OUTCOMES.find((o) => o.capability === cap)?.title ?? cap;
}