import { describe, it, expect } from "vitest";
import { projectMandate, findMissionView, owningCapability } from "./mandate";
import { STAGE_SEQUENCE } from "./stageMetadata";
import type { MissionState, MissionStatus, WorkspaceMission } from "./types";

function missions(
  overrides: Partial<Record<WorkspaceMission, MissionStatus>> = {},
): Record<WorkspaceMission, MissionState> {
  const out = {} as Record<WorkspaceMission, MissionState>;
  for (const s of STAGE_SEQUENCE) {
    out[s] = {
      status: overrides[s] ?? "locked",
      label: s,
      summary: "",
      href: `/x/${s}`,
    };
  }
  return out;
}

describe("projectMandate", () => {
  it("treats an unknown mandate as fully in scope (never hides on unknown) — except the stage withheld from customers", () => {
    const views = projectMandate(missions(), null);
    expect(views).toHaveLength(6);
    expect(findMissionView(views, "tax")).toBeUndefined();
    expect(views.every((v) => v.mandateStatus === "in_scope")).toBe(true);
    expect(views.every((v) => v.visible)).toBe(true);
  });

  it("keeps workflow status untouched — the two dimensions stay orthogonal", () => {
    const views = projectMandate(
      missions({ prepare: "review_required", tax: "locked" }),
      { engagementId: "e1", granted: ["FINANCIAL_STATEMENTS"] },
    );
    expect(findMissionView(views, "prepare")!.workflowStatus).toBe("review_required");
    const compliance = findMissionView(views, "compliance")!;
    expect(compliance.workflowStatus).toBe("locked");
    expect(compliance.mandateStatus).toBe("out_of_scope");
  });

  it("statements-only mandate hides tax, compliance, filing and monitor", () => {
    const views = projectMandate(missions(), {
      engagementId: "e1",
      granted: ["FINANCIAL_STATEMENTS"],
    });
    const visible = views.filter((v) => v.visible).map((v) => v.stage);
    expect(visible).toEqual(["prepare", "reconcile", "statements"]);
  });

  it("compliance-only mandate shows compliance in scope and its source stages as evidence only", () => {
    const views = projectMandate(missions(), {
      engagementId: "e1",
      granted: ["COMPLIANCE_REVIEW"],
    });
    const compliance = findMissionView(views, "compliance")!;
    expect(compliance.mandateStatus).toBe("in_scope");
    expect(compliance.prerequisiteOnly).toBe(false);

    const statements = findMissionView(views, "statements")!;
    expect(statements.visible).toBe(true);
    expect(statements.prerequisiteOnly).toBe(true);
    // Evidence never asserts a statements mandate.
    expect(statements.mandateStatus).toBe("out_of_scope");

    expect(findMissionView(views, "monitor")!.visible).toBe(false);
  });

  it("a withheld (tax-only) mandate projects nothing: no tax view, and it activates not even its evidence stages", () => {
    const views = projectMandate(missions({ tax: "signed", statements: "passed" }), {
      engagementId: "e1",
      granted: ["TAX_COMPUTATION"],
    });
    expect(findMissionView(views, "tax")).toBeUndefined();
    expect(views.some((v) => v.visible)).toBe(false);
  });

  it("retains completed work after a capability is withdrawn", () => {
    const views = projectMandate(missions({ monitor: "passed" }), {
      engagementId: "e1",
      granted: ["FINANCIAL_STATEMENTS"],
    });
    const monitor = findMissionView(views, "monitor")!;
    expect(monitor.mandateStatus).toBe("out_of_scope");
    expect(monitor.visible).toBe(false);
    expect(monitor.retainedWork).toBe(true);
  });

  it("does not claim retained work for an out-of-scope stage that never ran", () => {
    const views = projectMandate(missions({ monitor: "locked" }), {
      engagementId: "e1",
      granted: ["FINANCIAL_STATEMENTS"],
    });
    expect(findMissionView(views, "monitor")!.retainedWork).toBe(false);
  });

  it("a stage shown as evidence is never counted as retained work", () => {
    const views = projectMandate(missions({ statements: "passed" }), {
      engagementId: "e1",
      granted: ["COMPLIANCE_REVIEW"],
    });
    const statements = findMissionView(views, "statements")!;
    expect(statements.prerequisiteOnly).toBe(true);
    expect(statements.retainedWork).toBe(false);
  });

  it("an empty mandate leaves nothing active", () => {
    const views = projectMandate(missions(), { engagementId: "e1", granted: [] });
    expect(views.some((v) => v.visible)).toBe(false);
  });

  it("maps every stage to exactly one owning capability", () => {
    for (const s of STAGE_SEQUENCE) {
      expect(owningCapability(s)).not.toBeNull();
    }
  });
});