import { describe, expect, it } from "vitest";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import { deriveOrientationSummary } from "./deriveOrientationSummary";
import type { UploadSnapshot } from "./types";

const CID = "c1";
const CNAME = "Acme Ltd";
const PY = 2025;

function upload(overrides: Partial<UploadSnapshot> = {}): UploadSnapshot {
  return {
    id: "u1",
    companyId: CID,
    companyName: CNAME,
    periodYear: PY,
    status: "complete",
    isValid: true,
    safishaStatus: "clean",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    processedAt: "2026-01-01T00:05:00.000Z",
    hasMapping: true,
    certificationVerdict: "certified",
    certificationBlocker: null,
    ...overrides,
  };
}

describe("deriveOrientationSummary", () => {
  it("no mandate declared yet: service is null, never a fabricated label", () => {
    const state = deriveWorkspaceState(CID, CNAME, PY, null);
    const summary = deriveOrientationSummary(state, null);
    expect(summary.service).toBeNull();
  });

  it("empty granted list: service is null, not an empty string", () => {
    const state = deriveWorkspaceState(CID, CNAME, PY, null);
    const summary = deriveOrientationSummary(state, []);
    expect(summary.service).toBeNull();
  });

  it("granted capabilities are joined via the SAME capabilityTitle authority used elsewhere", () => {
    const state = deriveWorkspaceState(CID, CNAME, PY, null);
    const summary = deriveOrientationSummary(state, ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"]);
    expect(summary.service).toBe("Financial statements, Tax computation");
  });

  it("current stage/status are read from workspaceState.nextAction — the same single authority the dominant CTA uses", () => {
    const state = deriveWorkspaceState(CID, CNAME, PY, null);
    const summary = deriveOrientationSummary(state, null);
    expect(summary.currentStageLabel).toBe("Prepare Data");
    expect(summary.currentStatusLabel).toBe("Import Trial Balance");
  });

  it("no stage completed yet: lastCompletedMilestone is null, not a fabricated placeholder", () => {
    const state = deriveWorkspaceState(CID, CNAME, PY, null);
    const summary = deriveOrientationSummary(state, null);
    expect(summary.lastCompletedMilestone).toBeNull();
  });

  it("one completed stage (prepare passed, awaiting statements): milestone names Prepare Data", () => {
    const state = deriveWorkspaceState(CID, CNAME, PY, upload({ hesabuPassedAt: null }));
    const summary = deriveOrientationSummary(state, null);
    expect(summary.lastCompletedMilestone).not.toBeNull();
    expect(summary.lastCompletedMilestone?.stageLabel).toBe("Prepare Data");
  });

  it("later completed stages win over earlier ones — the MOST advanced milestone is shown, not the first", () => {
    const state = deriveWorkspaceState(
      CID,
      CNAME,
      PY,
      upload({ hesabuPassedAt: "2026-02-01T00:00:00.000Z", kingaSignedAt: "2026-03-01T00:00:00.000Z" }),
    );
    const summary = deriveOrientationSummary(state, null);
    // PATH 10: prepare=passed, statements=passed, tax=signed, filing=ready — the latest completed stage is tax.
    expect(summary.lastCompletedMilestone?.stageLabel).toBe("Compute Tax");
  });

  it("a review-required or in-progress stage never counts as a completed milestone", () => {
    const state = deriveWorkspaceState(CID, CNAME, PY, upload({ status: "needs_review", isValid: null }));
    const summary = deriveOrientationSummary(state, null);
    expect(summary.lastCompletedMilestone).toBeNull();
  });

  it("engagement complete: the milestone is the final signed filing stage", () => {
    const state = deriveWorkspaceState(
      CID,
      CNAME,
      PY,
      upload({
        hesabuPassedAt: "2026-02-01T00:00:00.000Z",
        kingaSignedAt: "2026-03-01T00:00:00.000Z",
        filingSubmittedAt: "2026-04-01T00:00:00.000Z",
      }),
    );
    const summary = deriveOrientationSummary(state, null);
    expect(summary.lastCompletedMilestone?.stageLabel).toBe("Prepare Outputs");
    expect(summary.lastCompletedMilestone?.at).toBe("2026-04-01T00:00:00.000Z");
  });
});
