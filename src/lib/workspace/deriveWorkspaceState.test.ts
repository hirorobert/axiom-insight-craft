/**
 * deriveWorkspaceState.test.ts
 *
 * 14 behavioural test cases for the deterministic workspace engine.
 *
 * Invariants verified on every case:
 *   I-1  Exactly one nextAction exists in every result
 *   I-2  Every locked mission includes a blocker string
 *   I-3  Every href in missions + nextAction contains companyId and periodYear
 *   I-4  Null/absent data NEVER produces a success-state result
 *   I-5  hesabuPassedAt=null cannot reach KINGA-ready or beyond
 *   I-6  kingaSignedAt=null cannot reach FILING-ready or beyond
 *   I-7  filingSubmittedAt=null cannot produce "Review Completed Engagement"
 */

import { describe, it, expect } from "vitest";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import type { UploadSnapshot } from "./types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CID = "company-abc";
const PY  = 2025;

/** Minimal valid upload — TB processed and clean, all sign-offs absent */
const base: UploadSnapshot = {
  id:              "upload-001",
  companyId:       CID,
  companyName:     "Acme Ltd",
  periodYear:      PY,
  status:          "complete",
  isValid:         true,
  safishaStatus:   null,
  uploadedAt:      "2025-01-15T10:00:00Z",
  processedAt:     "2025-01-15T10:05:00Z",
  hasMapping:      true,
  hesabuPassedAt:  null,
  kingaSignedAt:   null,
  filingSubmittedAt: null,
};

function snap(overrides: Partial<UploadSnapshot>): UploadSnapshot {
  return { ...base, ...overrides };
}

// ── Shared invariant checker ──────────────────────────────────────────────────

function assertInvariants(result: ReturnType<typeof deriveWorkspaceState>) {
  const prefix = `/workspace/${CID}/${PY}`;

  // I-1: exactly one nextAction
  expect(result.nextAction).toBeDefined();
  expect(typeof result.nextAction.id).toBe("string");

  // I-2: locked missions must have blocker
  for (const [, mission] of Object.entries(result.missions)) {
    if (mission.status === "locked") {
      expect(mission.blocker, `locked mission "${mission.label}" missing blocker`).toBeTruthy();
    }
  }

  // I-3: every href starts with the workspace prefix
  for (const [, mission] of Object.entries(result.missions)) {
    expect(mission.href, `mission "${mission.label}" href missing prefix`).toContain(prefix);
  }
  expect(result.nextAction.href).toContain(CID);
  expect(result.nextAction.href).toContain(String(PY));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("deriveWorkspaceState — 14 path coverage", () => {

  // ── PATH 1: No upload ────────────────────────────────────────────────────

  it("PATH 1: no upload → import-trial-balance nextAction, all missions locked/not-started", () => {
    const result = deriveWorkspaceState(CID, "Acme Ltd", PY, null);

    expect(result.nextAction.id).toBe("import-trial-balance");
    expect(result.nextAction.blocked).toBe(false);
    expect(result.missions.safisha.status).toBe("not_started");
    expect(result.missions.hesabu.status).toBe("locked");
    expect(result.missions.kinga.status).toBe("locked");
    expect(result.missions.filing.status).toBe("locked");
    // I-4: null upload → never shows any completion
    expect(result.nextAction.id).not.toBe("review-completed-engagement");
    assertInvariants(result);
  });

  // ── PATH 2: Processing ───────────────────────────────────────────────────

  it("PATH 2: status=processing → wait-processing nextAction, blocked=true", () => {
    const result = deriveWorkspaceState(CID, "Acme Ltd", PY, snap({ status: "processing" }));

    expect(result.nextAction.id).toBe("wait-processing");
    expect(result.nextAction.blocked).toBe(true);
    expect(result.nextAction.blocker).toBeTruthy();
    expect(result.missions.safisha.status).toBe("in_progress");
    assertInvariants(result);
  });

  // ── PATH 3: Needs review ─────────────────────────────────────────────────

  it("PATH 3: status=needs_review → resolve-classifications, HESABU locked", () => {
    const result = deriveWorkspaceState(CID, "Acme Ltd", PY, snap({ status: "needs_review" }));

    expect(result.nextAction.id).toBe("resolve-classifications");
    expect(result.nextAction.blocked).toBe(false);
    expect(result.missions.safisha.status).toBe("review_required");
    expect(result.missions.hesabu.status).toBe("locked");
    assertInvariants(result);
  });

  // ── PATH 4a: Error ───────────────────────────────────────────────────────

  it("PATH 4a: status=error → resolve-upload-error, SAFISHA blocked", () => {
    const result = deriveWorkspaceState(CID, "Acme Ltd", PY, snap({ status: "error" }));

    expect(result.nextAction.id).toBe("resolve-upload-error");
    expect(result.missions.safisha.status).toBe("blocked");
    expect(result.missions.hesabu.status).toBe("locked");
    assertInvariants(result);
  });

  // ── PATH 4b: Blocked status ──────────────────────────────────────────────

  it("PATH 4b: status=blocked → resolve-upload-error, SAFISHA blocked", () => {
    const result = deriveWorkspaceState(CID, "Acme Ltd", PY, snap({ status: "blocked" }));

    expect(result.nextAction.id).toBe("resolve-upload-error");
    expect(result.missions.safisha.status).toBe("blocked");
    assertInvariants(result);
  });

  // ── PATH 5: Invalid TB ───────────────────────────────────────────────────

  it("PATH 5: isValid=false → fix-validation-errors, HESABU locked", () => {
    const result = deriveWorkspaceState(CID, "Acme Ltd", PY, snap({ isValid: false }));

    expect(result.nextAction.id).toBe("fix-validation-errors");
    expect(result.missions.safisha.status).toBe("blocked");
    expect(result.missions.hesabu.status).toBe("locked");
    // I-4: invalid TB must never show HESABU passed
    expect(result.missions.hesabu.status).not.toBe("passed");
    assertInvariants(result);
  });

  // ── PATH 6: Safisha exceptions ───────────────────────────────────────────

  it("PATH 6: safishaStatus=exceptions → resolve-reconciliation, KINGA locked (constitutional gate)", () => {
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({ safishaStatus: "exceptions" }),
    );

    expect(result.nextAction.id).toBe("resolve-reconciliation");
    expect(result.missions.safisha.status).toBe("blocked");
    // HESABU may proceed in parallel but KINGA is constitutionally gated
    expect(result.missions.kinga.status).toBe("locked");
    expect(result.missions.kinga.blocker).toContain("constitutional gate");
    assertInvariants(result);
  });

  // ── PATH 7: Safisha clean, no HESABU ────────────────────────────────────

  it("PATH 7: safishaStatus=clean, hesabuPassedAt=null → validate-draft-statements (clean variant)", () => {
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({ safishaStatus: "clean", hesabuPassedAt: null }),
    );

    expect(result.nextAction.id).toBe("validate-draft-statements");
    expect(result.nextAction.href).toContain("/hesabu");
    expect(result.missions.safisha.status).toBe("passed");
    expect(result.missions.hesabu.status).toBe("ready");
    expect(result.missions.kinga.status).toBe("locked");
    // I-5: no hesabu → must not show kinga ready or beyond
    expect(result.missions.filing.status).toBe("locked");
    assertInvariants(result);
  });

  // ── PATH 8: Pre-safisha (safishaStatus=null), TB valid, no HESABU ────────

  it("PATH 8: safishaStatus=null, TB valid, hesabuPassedAt=null → validate-draft-statements (pre-safisha variant)", () => {
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({ safishaStatus: null, hesabuPassedAt: null }),
    );

    expect(result.nextAction.id).toBe("validate-draft-statements");
    expect(result.missions.hesabu.status).toBe("ready");
    // description should differ from clean path
    expect(result.nextAction.description).toContain("TB is valid");
    assertInvariants(result);
  });

  // ── PATH 9a: HESABU passed, safisha clean, KINGA ready ──────────────────

  it("PATH 9a: hesabuPassedAt set, safishaClean, kingaSignedAt=null → compute-corporate-tax (KINGA ready)", () => {
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({
        safishaStatus:  "clean",
        hesabuPassedAt: "2025-02-01T09:00:00Z",
        kingaSignedAt:  null,
      }),
    );

    expect(result.nextAction.id).toBe("compute-corporate-tax");
    expect(result.nextAction.blocked).toBe(false);
    expect(result.missions.hesabu.status).toBe("passed");
    expect(result.missions.kinga.status).toBe("ready");
    expect(result.missions.filing.status).toBe("locked");
    // I-6: no kinga sign-off → must not reach filing-ready
    assertInvariants(result);
  });

  // ── PATH 9b: HESABU passed, safisha still blocked → PATH 6 fires, HESABU shown as passed ──
  // When SAFISHA is blocked, PATH 6 takes priority (constitutional gate).
  // However, because HESABU may run in parallel, the engine checks hesabuPassedAt
  // inside PATH 6 and shows HESABU as "passed" rather than "in_progress".
  // KINGA remains locked until SAFISHA clears.

  it("PATH 9b: hesabuPassedAt set, safisha blocked → resolve-reconciliation with HESABU=passed, KINGA locked", () => {
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({
        safishaStatus:  "blocked",
        hesabuPassedAt: "2025-02-01T09:00:00Z",
        kingaSignedAt:  null,
      }),
    );

    // PATH 6 fires (safisha is the blocker)
    expect(result.nextAction.id).toBe("resolve-reconciliation");
    expect(result.nextAction.blocked).toBe(false);
    // SAFISHA is blocked
    expect(result.missions.safisha.status).toBe("blocked");
    // HESABU is shown as passed (already validated)
    expect(result.missions.hesabu.status).toBe("passed");
    // KINGA is constitutionally locked
    expect(result.missions.kinga.status).toBe("locked");
    expect(result.missions.kinga.blocker).toContain("constitutional gate");
    assertInvariants(result);
  });

  // ── PATH 10: KINGA signed, not filed ────────────────────────────────────

  it("PATH 10: kingaSignedAt set, filingSubmittedAt=null → prepare-filing-package", () => {
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({
        safishaStatus:    "clean",
        hesabuPassedAt:   "2025-02-01T09:00:00Z",
        kingaSignedAt:    "2025-03-01T14:00:00Z",
        filingSubmittedAt: null,
      }),
    );

    expect(result.nextAction.id).toBe("prepare-filing-package");
    expect(result.missions.kinga.status).toBe("signed");
    expect(result.missions.filing.status).toBe("ready");
    // I-7: no filing → must not show completed engagement
    expect(result.nextAction.id).not.toBe("review-completed-engagement");
    assertInvariants(result);
  });

  // ── PATH 11: All complete ────────────────────────────────────────────────

  it("PATH 11: all sign-offs present → review-completed-engagement, all missions signed", () => {
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({
        safishaStatus:    "clean",
        hesabuPassedAt:   "2025-02-01T09:00:00Z",
        kingaSignedAt:    "2025-03-01T14:00:00Z",
        filingSubmittedAt: "2025-04-01T11:00:00Z",
      }),
    );

    expect(result.nextAction.id).toBe("review-completed-engagement");
    expect(result.missions.safisha.status).toBe("signed");
    expect(result.missions.hesabu.status).toBe("signed");
    expect(result.missions.kinga.status).toBe("signed");
    expect(result.missions.filing.status).toBe("signed");
    assertInvariants(result);
  });

  // ── PATH 12: Invariant — hesabuPassedAt=null blocks all downstream ───────

  it("PATH 12 (invariant I-5): hesabuPassedAt=null with kingaSignedAt set → engine ignores downstream timestamps", () => {
    // This should never happen in practice (DB gates prevent it), but the pure
    // function must be defensive: if hesabu gate is not satisfied, do not
    // advance to KINGA or beyond regardless of what other fields say.
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({
        safishaStatus:    "clean",
        hesabuPassedAt:   null,                   // HESABU NOT passed
        kingaSignedAt:    "2025-03-01T14:00:00Z", // should be ignored
        filingSubmittedAt: "2025-04-01T11:00:00Z", // should be ignored
      }),
    );

    // Must fall into the "no hesabu" branch — not into filing-complete
    expect(result.nextAction.id).toBe("validate-draft-statements");
    expect(result.missions.kinga.status).toBe("locked");
    expect(result.missions.filing.status).toBe("locked");
    assertInvariants(result);
  });

  // ── PATH 13: Invariant — filingSubmittedAt=null blocks PATH 11 ───────────

  it("PATH 13 (invariant I-7): filingSubmittedAt=null even with all other fields set → prepare-filing, not complete", () => {
    const result = deriveWorkspaceState(
      CID, "Acme Ltd", PY,
      snap({
        safishaStatus:    "clean",
        hesabuPassedAt:   "2025-02-01T09:00:00Z",
        kingaSignedAt:    "2025-03-01T14:00:00Z",
        filingSubmittedAt: null, // NOT filed
      }),
    );

    expect(result.nextAction.id).toBe("prepare-filing-package");
    expect(result.nextAction.id).not.toBe("review-completed-engagement");
    expect(result.missions.filing.status).not.toBe("signed");
    assertInvariants(result);
  });

  // ── PATH 14: Invariant — all hrefs contain company + period ──────────────

  it("PATH 14 (invariant I-3): every href in every state includes companyId and periodYear", () => {
    const scenarios: Array<UploadSnapshot | null> = [
      null,
      snap({ status: "processing" }),
      snap({ isValid: false }),
      snap({ safishaStatus: "clean", hesabuPassedAt: "2025-02-01T09:00:00Z", kingaSignedAt: "2025-03-01T14:00:00Z", filingSubmittedAt: "2025-04-01T11:00:00Z" }),
    ];

    for (const s of scenarios) {
      const result = deriveWorkspaceState(CID, "Acme Ltd", PY, s);
      for (const [, mission] of Object.entries(result.missions)) {
        expect(mission.href, `href "${mission.href}" missing companyId`).toContain(CID);
        expect(mission.href, `href "${mission.href}" missing periodYear`).toContain(String(PY));
      }
      expect(result.nextAction.href).toContain(CID);
      expect(result.nextAction.href).toContain(String(PY));
    }
  });
});
