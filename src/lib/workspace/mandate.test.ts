import { describe, it, expect } from "vitest";
import { projectMandate, findMissionView, owningCapability, type EngagementCapability } from "./mandate";
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
  it("treats an unknown mandate as fully in scope (never hides on unknown) — except the stages withheld from customers", () => {
    const views = projectMandate(missions(), null);
    expect(views.map((v) => v.stage)).toEqual(["prepare", "reconcile"]);
    expect(views.every((v) => v.mandateStatus === "in_scope")).toBe(true);
    expect(views.every((v) => v.visible)).toBe(true);
  });

  it("keeps workflow status untouched — the two dimensions stay orthogonal", () => {
    const views = projectMandate(
      missions({ prepare: "review_required", tax: "locked" }),
      { engagementId: "e1", granted: ["FINANCIAL_STATEMENTS"] },
    );
    expect(findMissionView(views, "prepare")!.workflowStatus).toBe("review_required");
    const reconcile = findMissionView(views, "reconcile")!;
    expect(reconcile.workflowStatus).toBe("locked");
    expect(reconcile.mandateStatus).toBe("in_scope");
    for (const s of ["statements", "tax", "compliance", "filing", "monitor"] as const) expect(findMissionView(views, s)).toBeUndefined();
  });

  it("the trial-balance-review mandate (FINANCIAL_STATEMENTS) shows Prepare and Reconcile only", () => {
    const views = projectMandate(missions(), {
      engagementId: "e1",
      granted: ["FINANCIAL_STATEMENTS"],
    });
    const visible = views.filter((v) => v.visible).map((v) => v.stage);
    expect(visible).toEqual(["prepare", "reconcile"]);
  });

  it("a withheld mandate (tax, compliance, filing, monitoring) projects nothing: no view, and it activates not even its evidence stages", () => {
    const sets: EngagementCapability[][] = [["TAX_COMPUTATION"], ["COMPLIANCE_REVIEW"], ["FILING_PREPARATION"], ["MONITORING"], ["TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION", "MONITORING"]];
    for (const granted of sets) {
      const views = projectMandate(missions({ tax: "signed", statements: "passed", compliance: "passed", filing: "signed", monitor: "passed" }), { engagementId: "e1", granted });
      for (const s of ["statements", "tax", "compliance", "filing", "monitor"] as const) expect(findMissionView(views, s)).toBeUndefined();
      expect(views.some((v) => v.visible)).toBe(false);
    }
  });

  it("a withheld stage carries no retained-work entry, even with completed work (its records are untouched)", () => {
    const views = projectMandate(missions({ monitor: "passed", statements: "passed" }), { engagementId: "e1", granted: ["FINANCIAL_STATEMENTS"] });
    expect(views.some((v) => v.retainedWork)).toBe(false);
    expect(findMissionView(views, "monitor")).toBeUndefined();
  });

  it("a visible stage outside the mandate keeps its completed work reachable as retained work", () => {
    const views = projectMandate(missions({ reconcile: "passed" }), { engagementId: "e1", granted: [] });
    const reconcile = findMissionView(views, "reconcile")!;
    expect(reconcile.mandateStatus).toBe("out_of_scope");
    expect(reconcile.retainedWork).toBe(true);
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