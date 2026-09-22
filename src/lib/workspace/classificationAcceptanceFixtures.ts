/**
 * classificationAcceptanceFixtures.ts — the deterministic, hand-written (uploadStatus, processingResult) inputs the
 * internal classification-states acceptance page feeds to the REAL deriveClassificationPresentation() from
 * classificationPresentation.ts. Every value here is a fixture literal: nothing is read from Supabase, nothing is
 * read from a live upload, and nothing here is randomised or time-dependent.
 *
 * One fixture per ClassificationState, chosen from exactly the same shapes classificationPresentation.test.ts proves
 * produce that state — see that file for the full precedence and data-lineage proof this module leans on.
 */

import type { ClassificationState } from "./classificationPresentation";

export interface ClassificationAcceptanceFixture {
  /** The state this fixture is written to produce — asserted by the focused test, not merely hoped for. */
  readonly expectedState: ClassificationState;
  readonly label: string;
  readonly uploadStatus: string;
  readonly processingResult: unknown;
}

const summary = (totalAccounts: number) => ({ total_accounts: totalAccounts, processed_at: "2026-01-01T00:00:00.000Z", parser_version: "v2.2", columns_detected: {}, auto_classified: 0 });

export const CLASSIFICATION_ACCEPTANCE_FIXTURES: readonly ClassificationAcceptanceFixture[] = [
  {
    expectedState: "FAILED",
    label: "FAILED — the upload's own status is blocked",
    uploadStatus: "blocked",
    processingResult: null,
  },
  {
    expectedState: "PROCESSING",
    label: "PROCESSING — the engine is currently running",
    uploadStatus: "processing",
    processingResult: null,
  },
  {
    expectedState: "INCONSISTENT",
    label: "INCONSISTENT — classified accounts exceed total accounts",
    uploadStatus: "needs_review",
    processingResult: {
      summary: summary(97),
      validation_report: { mapping_completeness: { mapped_accounts: 200 } },
      needs_review_accounts: [],
    },
  },
  {
    expectedState: "COMPLETE_WITH_REVIEW",
    label: "COMPLETE_WITH_REVIEW — status confirms 12 accounts need review",
    uploadStatus: "needs_review",
    processingResult: {
      summary: summary(97),
      validation_report: { mapping_completeness: { mapped_accounts: 85 } },
      needs_review_accounts: new Array(12).fill({ account_code: "6100", account_name: "Fixture account" }),
    },
  },
  {
    expectedState: "PARTIAL",
    label: "PARTIAL — 15 accounts positively need review, under a status this module does not itself confirm",
    uploadStatus: "valid",
    processingResult: {
      summary: summary(97),
      validation_report: { mapping_completeness: { mapped_accounts: 82 } },
      needs_review_accounts: new Array(15).fill({ account_code: "6200", account_name: "Fixture account" }),
    },
  },
  {
    expectedState: "COMPLETE_NO_REVIEW",
    label: "COMPLETE_NO_REVIEW — every parsed account is classified",
    uploadStatus: "complete",
    processingResult: {
      summary: summary(97),
      validation_report: { mapping_completeness: { mapped_accounts: 97, needs_review: 0 } },
    },
  },
  {
    expectedState: "NOT_COMPUTED",
    label: "NOT_COMPUTED — no processing_result exists yet",
    uploadStatus: "needs_review",
    processingResult: null,
  },
];
