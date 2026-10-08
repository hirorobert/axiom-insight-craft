// reporting/disclosures.ts — which Close Review adjustments the sign-off pack must disclose. Pure.
//
// An approved adjustment is disclosed when its approver was its proposer (self-approval), or when it was carried to the
// current trial balance by its own proposer (self-revalidation). Every other adjustment is not listed: the pack discloses
// the exceptions, it does not restate the journal.
import type { AdjustmentsSummary } from "@/lib/closeReview/adjustments";
import type { PackAdjustmentDisclosure } from "@/lib/exports/reportPack";

export function adjustmentDisclosures(summary: AdjustmentsSummary | null): PackAdjustmentDisclosure[] {
  if (!summary || summary.state === "unavailable") return [];
  return summary.adjustments
    .filter((a) => a.status === "approved")
    .map((a) => ({ number: a.number, reason: a.reason, totalMinor: a.totalMinor, selfApproved: a.selfApproved, selfRevalidated: a.bindings.some((b) => b.decision === "revalidated" && b.selfApproved) }))
    .filter((a) => a.selfApproved || a.selfRevalidated)
    .sort((x, y) => x.number - y.number);
}
