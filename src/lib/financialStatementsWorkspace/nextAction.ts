// financialStatementsWorkspace/nextAction.ts — exactly one dominant next
// action for the workspace state. Pure and ordered: the first unmet
// precondition wins, so the reviewer is never shown two competing primary
// actions.

import type { FindingView } from "./findingsView";
import type { StructureModel } from "./structureModel";

export const WORKSPACE_STAGES = ["sources", "structure", "statements", "notes", "validate", "review", "outputs"] as const;
export type WorkspaceStage = (typeof WORKSPACE_STAGES)[number];

export const STAGE_LABELS: Readonly<Record<WorkspaceStage, string>> = {
  sources: "Sources",
  structure: "Structure",
  statements: "Statements",
  notes: "Notes & Policies",
  validate: "Validate",
  review: "Professional Review",
  outputs: "Final Outputs",
};

export function isWorkspaceStage(value: string | null | undefined): value is WorkspaceStage {
  return !!value && (WORKSPACE_STAGES as readonly string[]).includes(value);
}

export interface NextAction {
  readonly stage: WorkspaceStage;
  readonly label: string;
  readonly reason: string;
}

export function deriveNextAction(input: { readonly structure: StructureModel; readonly views: readonly FindingView[]; readonly hasReport: boolean }): NextAction {
  const codes = new Set(input.structure.diagnostics.filter((d) => d.severity === "BLOCKING").map((d) => d.code));
  if (codes.has("COMPARATIVE_MISSING")) return { stage: "sources", label: "Review sources", reason: "The comparative period is missing." };
  if (codes.has("FRAMEWORK_NOT_SET") || codes.has("CURRENCY_NOT_SET") || codes.has("PERIOD_BASIS_ASSUMED") || codes.has("FRAMEWORK_UNSUPPORTED_FROM_TRIAL_BALANCE")) {
    return { stage: "structure", label: "Resolve structure", reason: "A reporting setting is not confirmed." };
  }
  if (codes.has("ACCOUNTS_UNMAPPED") || codes.has("ACCOUNTS_AMBIGUOUS")) return { stage: "structure", label: "Resolve account mapping", reason: "Some accounts are unmapped or ambiguous." };
  if (!input.hasReport) return { stage: "sources", label: "Review sources", reason: "No statements have been prepared yet." };
  const open = input.views.filter((v) => v.bucket === "BLOCKING" || v.bucket === "INSUFFICIENT_EVIDENCE");
  if (open.length > 0) return { stage: "review", label: `Review ${open.length} open finding${open.length === 1 ? "" : "s"}`, reason: "Blocking or insufficient-evidence findings remain." };
  if (input.structure.composition && input.structure.composition.blockers.length > 0) return { stage: "statements", label: "See incomplete statements", reason: "Required statements still need evidence." };
  return { stage: "outputs", label: "Review final outputs", reason: "No blocking findings or composition gaps remain." };
}
