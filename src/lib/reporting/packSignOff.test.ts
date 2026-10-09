import { describe, expect, it } from "vitest";
import { packSignOffFor, type BindingRow } from "./packSignOff";

const row = (state: string, o: Partial<BindingRow> = {}): BindingRow => ({
  state, documentSha256: "d".repeat(64), dependenciesSha256: "e".repeat(64), approverFirmMemberId: "m-1", approverRole: "owner",
  approverDisplayName: "Humphrey", approvedAt: `2026-10-09T14:1${state === "FINAL" ? 1 : 0}:00Z`, signoffPolicy: null, signoffPolicyEventId: null, sameApprover: null, ...o,
});

describe("the sign-off a pack prints (statement sign-off policy, 20261024100000)", () => {
  it("a sign-off recorded before the policy carries no approvals: the sealed pack renders exactly as it did", () => {
    const s = packSignOffFor("FINAL", [row("REVIEWED"), row("FINAL")], null)!;
    expect(s).toEqual({ state: "FINAL", signedAt: "2026-10-09T14:11:00Z", signedBy: "Humphrey (owner)", contentHash: "d".repeat(64), dependenciesSha256: "e".repeat(64) });
    expect("approvals" in s).toBe(false);
  });
  it("separate approvers: both named, not the same person", () => {
    const s = packSignOffFor("FINAL", [row("REVIEWED", { approverDisplayName: "Asha", approverRole: "partner", signoffPolicy: "separate_approvers" }),
      row("FINAL", { signoffPolicy: "separate_approvers", sameApprover: false })], null)!;
    expect(s.approvals).toEqual({ reviewedBy: "Asha (partner)", reviewedAt: "2026-10-09T14:10:00Z", policy: "separate_approvers", sameApprover: false, soloOwner: null });
  });
  it("solo owner: the same person, with the recorded policy's reason", () => {
    const s = packSignOffFor("FINAL", [row("REVIEWED", { signoffPolicy: "solo_owner" }), row("FINAL", { signoffPolicy: "solo_owner", signoffPolicyEventId: "ev", sameApprover: true })],
      { reason: "One owner", setAt: "2026-10-09" })!;
    expect(s.approvals).toEqual({ reviewedBy: "Humphrey (owner)", reviewedAt: "2026-10-09T14:10:00Z", policy: "solo_owner", sameApprover: true, soloOwner: { reason: "One owner", setAt: "2026-10-09" } });
  });
  it("no binding for the state, or a draft: no sign-off", () => {
    expect(packSignOffFor("FINAL", [row("REVIEWED")], null)).toBeNull();
    expect(packSignOffFor("DRAFT", [], null)).toBeNull();
  });
});
