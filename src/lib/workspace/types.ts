/**
 * Workspace Architecture Types
 * Pure type definitions — no side effects, no imports.
 */

export type MissionStatus =
  | "not_started"
  | "in_progress"
  | "ready"
  | "passed"
  | "review_required"
  | "blocked"
  | "signed"
  | "locked"
  | "not_applicable";

export type WorkspaceMission =
  | "safisha"
  | "hesabu"
  | "kinga"
  | "filing"
  | "analytics"
  | "issues";

export interface NextAction {
  id: string;
  label: string;
  description: string;
  href: string;
  blocked: boolean;
  blocker?: string;
  mission: WorkspaceMission;
  priority: number;
}

export interface MissionState {
  status: MissionStatus;
  label: string;
  summary: string;
  href: string;
  blocker?: string;
}

export interface WorkspaceState {
  companyId: string;
  periodYear: number;
  companyName: string;
  currentUploadId?: string;
  lastUpdatedAt?: string;
  missions: Record<WorkspaceMission, MissionState>;
  nextAction: NextAction;
}

/**
 * Snapshot of upload state passed into deriveWorkspaceState.
 * All optional downstream states use null = NOT_COMPUTED (not false).
 */
export interface UploadSnapshot {
  id: string;
  companyId: string;
  companyName: string;
  periodYear: number;
  status: string;               // processing|complete|error|blocked|needs_review
  isValid: boolean | null;      // null = not yet validated
  safishaStatus: string | null; // null|processing|needs_review|blocked|clean
  uploadedAt: string;
  processedAt: string | null;
  hasMapping: boolean;          // processing_result?.mapping exists
  hesabuPassedAt?: string | null;
  kingaSignedAt?: string | null;
  filingSubmittedAt?: string | null;
}
