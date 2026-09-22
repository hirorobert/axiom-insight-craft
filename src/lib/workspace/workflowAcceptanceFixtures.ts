/**
 * workflowAcceptanceFixtures.ts — deterministic, hand-written UploadSnapshot inputs the internal
 * workflow-states acceptance page feeds to the REAL deriveWorkspaceState() from
 * deriveWorkspaceState.ts. Every value here is a fixture literal: nothing is read from Supabase,
 * nothing is read from a live upload, and nothing here is randomised or time-dependent — the same
 * discipline classificationAcceptanceFixtures.ts (PR #30) established for the 7 classification
 * states, extended to the FULL canonical workflow (deriveWorkspaceState's 11 paths, including the
 * three PATH 6B certification-readiness sub-states requirement #8 names explicitly:
 * "contradiction", "missing-certification" and "stale-processing").
 *
 * "contradiction" is the exact live-observed defect PR #31 fixed (2026-09-22): classification
 * complete (is_valid=true) but SAFISHA certification blocked on an arithmetic difference — Overview
 * must show the certification failure, never "TB is valid".
 */

import type { UploadSnapshot } from "./types";

export interface WorkflowAcceptanceFixture {
  readonly id: string;
  readonly label: string;
  readonly snapshot: UploadSnapshot | null;
}

const CID = "fixture-company";
const COMPANY_NAME = "Acceptance Fixture Ltd";
const PY = 2025;

function base(overrides: Partial<UploadSnapshot>): UploadSnapshot {
  return {
    id: "fixture-upload",
    companyId: CID,
    companyName: COMPANY_NAME,
    periodYear: PY,
    status: "complete",
    isValid: true,
    safishaStatus: null,
    uploadedAt: "2026-01-01T09:00:00.000Z",
    processedAt: "2026-01-01T09:05:00.000Z",
    hasMapping: true,
    hesabuPassedAt: null,
    kingaSignedAt: null,
    filingSubmittedAt: null,
    certificationVerdict: "certified",
    certificationBlocker: null,
    ...overrides,
  };
}

export const WORKFLOW_ACCEPTANCE_FIXTURES: readonly WorkflowAcceptanceFixture[] = [
  { id: "no-upload", label: "PATH 1 — No trial balance imported yet", snapshot: null },
  {
    id: "processing",
    label: "PATH 2 — Trial balance is processing",
    snapshot: base({ status: "processing", isValid: null }),
  },
  {
    id: "needs-review",
    label: "PATH 3 — Account classification needs review",
    snapshot: base({ status: "needs_review", isValid: null }),
  },
  {
    id: "upload-error",
    label: "PATH 4 — Upload processing failed",
    snapshot: base({ status: "error", isValid: null }),
  },
  {
    id: "invalid-tb",
    label: "PATH 5 — Trial balance has accounting errors",
    snapshot: base({ isValid: false }),
  },
  {
    id: "safisha-blocked",
    label: "PATH 6 — Reconciliation exceptions block Prepare Data",
    snapshot: base({ safishaStatus: "needs_review", certificationVerdict: "certified" }),
  },
  {
    id: "certification-contradiction",
    label: "PATH 6B — Certification CONTRADICTION (the live-observed defect PR #31 fixed)",
    snapshot: base({
      certificationVerdict: "blocked",
      certificationBlocker: "Debits 185969447743.17 != Credits 185969172163.17 (difference: 275580.00)",
    }),
  },
  {
    id: "certification-missing",
    label: "PATH 6B — MISSING certification (the read has not resolved yet — never treated as a pass)",
    snapshot: (() => {
      const { certificationVerdict, certificationBlocker, ...rest } = base({});
      void certificationVerdict;
      void certificationBlocker;
      return rest as UploadSnapshot;
    })(),
  },
  {
    id: "certification-review",
    label: "PATH 6B — Certification needs a review decision",
    snapshot: base({ certificationVerdict: "review", certificationBlocker: "Some accounts still need a classification decision." }),
  },
  {
    id: "certification-stale",
    label: "PATH 6B — STALE-PROCESSING (certification no longer current for this upload)",
    snapshot: base({ certificationVerdict: "stale", certificationBlocker: "This trial balance does not have a current authoritative certification." }),
  },
  {
    id: "ready-for-statements",
    label: "PATH 7/8 — Certified, ready to validate statements",
    snapshot: base({ safishaStatus: "clean" }),
  },
  {
    id: "ready-for-tax",
    label: "PATH 9 — Statements validated, ready to compute tax",
    snapshot: base({ safishaStatus: "clean", hesabuPassedAt: "2026-02-01T00:00:00.000Z" }),
  },
  {
    id: "ready-for-filing",
    label: "PATH 10 — Tax signed, ready to prepare filing outputs",
    snapshot: base({
      safishaStatus: "clean",
      hesabuPassedAt: "2026-02-01T00:00:00.000Z",
      kingaSignedAt: "2026-03-01T00:00:00.000Z",
    }),
  },
  {
    id: "engagement-complete",
    label: "PATH 11 — Filing submitted, engagement complete",
    snapshot: base({
      safishaStatus: "clean",
      hesabuPassedAt: "2026-02-01T00:00:00.000Z",
      kingaSignedAt: "2026-03-01T00:00:00.000Z",
      filingSubmittedAt: "2026-04-01T00:00:00.000Z",
    }),
  },
];

export { CID as WORKFLOW_FIXTURE_COMPANY_ID, COMPANY_NAME as WORKFLOW_FIXTURE_COMPANY_NAME, PY as WORKFLOW_FIXTURE_PERIOD_YEAR };
