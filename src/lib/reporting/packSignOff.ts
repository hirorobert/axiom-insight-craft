// reporting/packSignOff.ts — the sign-off a pack prints, from the server's bindings of ONE version. Pure.
//
// A sign-off recorded under the statement sign-off policy (20261024100000) carries both approvers and the policy, and the
// pack discloses them. A sign-off recorded before it carries neither, and its pack renders exactly as it did when it was
// sealed: nothing is inferred for it.

import type { PackSignOff } from "@/lib/exports/reportPack";
import { approverText, type SignoffPolicy } from "./signoff";

export interface BindingRow {
  readonly state: string;
  readonly documentSha256: string;
  readonly dependenciesSha256: string;
  readonly approverFirmMemberId: string | null;
  readonly approverRole: string | null;
  readonly approverDisplayName: string | null;
  readonly approvedAt: string | null;
  readonly signoffPolicy: SignoffPolicy | null;
  readonly signoffPolicyEventId: string | null;
  readonly sameApprover: boolean | null;
}

export function packSignOffFor(
  versionState: string,
  bindings: readonly BindingRow[],
  soloOwnerEvent: { readonly reason: string; readonly setAt: string } | null,
): PackSignOff | null {
  if (versionState !== "REVIEWED" && versionState !== "FINAL") return null;
  const binding = bindings.find((b) => b.state === versionState) ?? null;
  if (!binding) return null;
  const reviewed = bindings.find((b) => b.state === "REVIEWED") ?? null;
  const approvals = binding.signoffPolicy && reviewed ? {
    reviewedBy: approverText(reviewed), reviewedAt: reviewed.approvedAt ?? "time not recorded", policy: binding.signoffPolicy,
    sameApprover: binding.sameApprover === true, soloOwner: binding.signoffPolicy === "solo_owner" ? soloOwnerEvent : null,
  } : undefined;
  return {
    state: versionState, signedAt: binding.approvedAt ?? "time not recorded", signedBy: approverText(binding),
    contentHash: binding.documentSha256, dependenciesSha256: binding.dependenciesSha256, ...(approvals ? { approvals } : {}),
  };
}
