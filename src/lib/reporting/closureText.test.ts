import { describe, expect, it } from "vitest";
import { approverText } from "./signoff";
import { blockerText } from "./blockers";

describe("the recorded approver is named from the record, never invented", () => {
  it("the display name on record, with the role", () => {
    expect(approverText({ approverDisplayName: "Pat Partner", approverRole: "partner", approverFirmMemberId: "0d1f2e3c-0000-4000-8000-000000000000" })).toBe("Pat Partner (partner)");
  });
  it("no name on record: the role and the stable membership reference, said plainly", () => {
    expect(approverText({ approverDisplayName: null, approverRole: "owner", approverFirmMemberId: "0d1f2e3c-0000-4000-8000-000000000000" })).toBe("owner 0d1f2e3c (no name on record)");
  });
  it("a binding recorded before approver recording says so", () => {
    expect(approverText({ approverDisplayName: null, approverRole: null, approverFirmMemberId: null })).toMatch(/not recorded/);
  });
});

describe("closure blockers in words", () => {
  it("unsupported and undecided cases are explicit", () => {
    expect(blockerText("REPORTING_CASE_UNSUPPORTED:smes.sci.5_5_g")).toBe("This reporting case is not supported, so the report cannot be finalised (smes.sci.5_5_g).");
    expect(blockerText("REQUIREMENT_UNDECIDED:smes.sci.5_5_e")).toMatch(/never treated as not applicable/);
  });
});
