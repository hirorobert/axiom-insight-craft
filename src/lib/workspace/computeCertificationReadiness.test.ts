import { describe, it, expect } from "vitest";
import {
  computeCertificationReadiness,
  type TbCertificationRow,
  type TbCertificationExceptionRecord,
} from "./computeCertificationReadiness";

const UPLOAD_A = "upload-a";
const UPLOAD_B = "upload-b";

function row(overrides: Partial<TbCertificationRow>): TbCertificationRow {
  return {
    id: "cert-1",
    sequence_no: 1,
    company_id: "company-1",
    upload_id: UPLOAD_B,
    period_year: 2025,
    is_blocking: false,
    requires_review: false,
    exceptions: [],
    certified_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function exc(overrides: Partial<TbCertificationExceptionRecord>): TbCertificationExceptionRecord {
  return {
    code: "TEST",
    layer: 5,
    severity: "info",
    accountCode: null,
    message: "test",
    ...overrides,
  };
}

describe("computeCertificationReadiness — no upload at all", () => {
  it("returns pending with zero checks when no trial balance exists", () => {
    const result = computeCertificationReadiness({
      uploadExists: false,
      currentUploadId: null,
      authoritative: null,
      latestForUpload: null,
    });
    expect(result.verdict).toBe("pending");
    expect(result.checks).toHaveLength(0);
  });
});

describe("computeCertificationReadiness — fetch failure never fabricates an answer", () => {
  it("returns 'unknown', not 'pending' or 'certified', when the read failed", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: null,
      fetchFailed: true,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("pending");
    expect(result.verdict).not.toBe("certified");
  });

  it("fetchFailed wins even if authoritative somehow carries a value for the current upload", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: row({ upload_id: UPLOAD_A }),
      latestForUpload: null,
      fetchFailed: true,
    });
    expect(result.verdict).toBe("unknown");
  });
});

describe("computeCertificationReadiness — never certified yet", () => {
  it("returns pending when the upload exists but no certification was ever committed anywhere", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: null,
    });
    expect(result.verdict).toBe("pending");
    expect(result.headline).toBe("Pre-flight check running");
  });
});

describe("computeCertificationReadiness — SAME upload as authoritative (§10)", () => {
  it("produces normal certified behavior when authoritative.upload_id matches the displayed upload", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_B,
      authoritative: row({ upload_id: UPLOAD_B, exceptions: [] }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
    expect(result.blocker).toBeNull();
  });

  it("marks L1-L4 passed and L5/L6 pending when no exceptions were recorded (pre-Slice-4A certification)", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_B,
      authoritative: row({ upload_id: UPLOAD_B, exceptions: [] }),
      latestForUpload: null,
    });
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.l1_structure.state).toBe("passed");
    expect(byId.l2_data_quality.state).toBe("passed");
    expect(byId.l3_arithmetic.state).toBe("passed");
    expect(byId.l4_classification.state).toBe("passed");
    expect(byId.l5_supporting_evidence.state).toBe("pending");
    expect(byId.l6_prior_period.state).toBe("pending");
  });

  it("stays certified when L5/L6 carry only informational entries", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_B,
      authoritative: row({
        upload_id: UPLOAD_B,
        exceptions: [
          exc({ code: "L5_SUPPORTING_EVIDENCE", layer: 5, severity: "info", message: "No supporting evidence available." }),
          exc({ code: "L6_PRIOR_PERIOD_SIGNAL", layer: 6, severity: "info", message: "No prior period on record." }),
        ],
      }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
  });
});

describe("computeCertificationReadiness — DIFFERENT upload than authoritative (§9, CRITICAL)", () => {
  it("never returns 'certified' when authoritative.upload_id !== currentUploadId", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: row({ upload_id: UPLOAD_B, is_blocking: false, requires_review: false, exceptions: [] }),
      latestForUpload: null,
    });
    expect(result.verdict).not.toBe("certified");
    expect(result.verdict).toBe("superseded");
  });

  it("does not present a POSITIVE Certified/Ready/Trusted/Safe-to-prepare claim for the displayed upload", () => {
    // "not the current certified upload" legitimately contains the word
    // "certified" (negated) — the invariant under test is that no POSITIVE
    // claim of certification is made, not that the word never appears.
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: row({ upload_id: UPLOAD_B, exceptions: [] }),
      latestForUpload: row({ upload_id: UPLOAD_A, is_blocking: false, requires_review: false, exceptions: [] }),
    });
    expect(result.verdict).not.toBe("certified");
    const text = `${result.headline} ${result.blocker ?? ""}`.toLowerCase();
    expect(text).not.toMatch(/\bis certified\b/);
    expect(text).not.toMatch(/\bready\b/);
    expect(text).not.toMatch(/trusted/);
    expect(text).not.toMatch(/safe to prepare/);
  });

  it("does not fabricate chronology ('newer') that isn't proven", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: row({ upload_id: UPLOAD_B, exceptions: [] }),
      latestForUpload: null,
    });
    const text = `${result.headline} ${result.blocker ?? ""}`.toLowerCase();
    expect(text).not.toMatch(/newer/);
  });

  it("still shows diagnostic per-layer detail for the displayed upload's own certification, if any", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: row({ upload_id: UPLOAD_B, exceptions: [] }),
      latestForUpload: row({
        upload_id: UPLOAD_A,
        exceptions: [exc({ layer: 4, severity: "warning", message: "2 accounts need review." })],
      }),
    });
    expect(result.verdict).toBe("superseded");
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.l4_classification.state).toBe("review");
  });

  it("shows all-pending diagnostic checks when the displayed upload has no certification of its own", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: row({ upload_id: UPLOAD_B, exceptions: [] }),
      latestForUpload: null,
    });
    expect(result.checks.every((c) => c.state === "pending")).toBe(true);
  });
});

describe("computeCertificationReadiness — direct-select can never create authority (§11, §12)", () => {
  it("never returns 'certified' from latestForUpload alone, even when it looks entirely clean", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: row({ upload_id: UPLOAD_A, is_blocking: false, requires_review: false, exceptions: [] }),
    });
    expect(result.verdict).not.toBe("certified");
  });

  it("RPC success + zero rows, with a historical/diagnostic row present, cannot produce authoritative readiness", () => {
    // This is the pure-function-boundary equivalent of "RPC returned zero
    // rows" (authoritative: null) combined with a diagnostic row existing.
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: row({ upload_id: UPLOAD_A, is_blocking: false, requires_review: false }),
    });
    expect(["blocked", "review", "stale", "pending", "unknown", "superseded"]).toContain(result.verdict);
    expect(result.verdict).not.toBe("certified");
  });
});

describe("computeCertificationReadiness — blocked", () => {
  it("reports blocked with the first error message when the latest certification is_blocking", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: row({
        upload_id: UPLOAD_A,
        is_blocking: true,
        requires_review: false,
        exceptions: [exc({ layer: 3, severity: "error", message: "Out by 1,200.00 — the file does not balance." })],
      }),
    });
    expect(result.verdict).toBe("blocked");
    expect(result.blocker).toBe("Out by 1,200.00 — the file does not balance.");
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.l3_arithmetic.state).toBe("failed");
  });
});

describe("computeCertificationReadiness — review", () => {
  it("reports review with the L4 message when requires_review is set", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: row({
        upload_id: UPLOAD_A,
        is_blocking: false,
        requires_review: true,
        exceptions: [exc({ layer: 4, severity: "warning", message: "3 accounts still need a mapping decision." })],
      }),
    });
    expect(result.verdict).toBe("review");
    expect(result.blocker).toBe("3 accounts still need a mapping decision.");
  });
});

describe("computeCertificationReadiness — stale wording no longer claims an unproven cause (§6)", () => {
  it("reports stale with generic non-authoritative wording, not a fabricated 'file changed' claim", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: row({ upload_id: UPLOAD_A, is_blocking: false, requires_review: false, exceptions: [] }),
    });
    expect(result.verdict).toBe("stale");
    expect(result.blocker).not.toMatch(/changed since/i);
    expect(result.blocker).not.toMatch(/source/i);
    expect(result.blocker).toBe("This trial balance does not have a current authoritative certification.");
  });

  it("is distinguishable from both 'pending' (never certified) and 'certified'", () => {
    const stale = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: row({ upload_id: UPLOAD_A, is_blocking: false, requires_review: false }),
    });
    const neverCertified = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: null,
    });
    expect(stale.verdict).not.toBe(neverCertified.verdict);
    expect(stale.verdict).not.toBe("certified");
  });

  it("is distinguishable from 'superseded' (different upload authoritative elsewhere)", () => {
    const stale = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: row({ upload_id: UPLOAD_A, is_blocking: false, requires_review: false }),
    });
    const superseded = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: row({ upload_id: UPLOAD_B, exceptions: [] }),
      latestForUpload: null,
    });
    expect(stale.verdict).not.toBe(superseded.verdict);
  });
});

describe("computeCertificationReadiness — L1 is never itself a failure source", () => {
  it("always reports L1 passed whenever any certification row exists, regardless of outcome", () => {
    const blocked = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: row({
        upload_id: UPLOAD_A,
        is_blocking: true,
        exceptions: [exc({ layer: 2, severity: "error", message: "bad" })],
      }),
    });
    const byId = Object.fromEntries(blocked.checks.map((c) => [c.id, c]));
    expect(byId.l1_structure.state).toBe("passed");
  });
});

describe("computeCertificationReadiness — exactly six top-level layers (§13)", () => {
  it("always returns exactly six checks, with these exact ids, when a row is present", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_B,
      authoritative: row({ upload_id: UPLOAD_B, exceptions: [] }),
      latestForUpload: null,
    });
    expect(result.checks).toHaveLength(6);
    expect(result.checks.map((c) => c.id)).toEqual([
      "l1_structure",
      "l2_data_quality",
      "l3_arithmetic",
      "l4_classification",
      "l5_supporting_evidence",
      "l6_prior_period",
    ]);
  });

  it("always returns exactly six checks even in the pending/no-row case", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_A,
      authoritative: null,
      latestForUpload: null,
    });
    expect(result.checks).toHaveLength(6);
  });
});

describe("computeCertificationReadiness — L5/L6 evidence states never block (§14)", () => {
  it("L5 NOT_EVALUATED does not block an otherwise-eligible certification", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_B,
      authoritative: row({
        upload_id: UPLOAD_B,
        exceptions: [exc({ code: "L5_SUPPORTING_EVIDENCE", layer: 5, severity: "info", message: "NOT_EVALUATED: no supporting-evidence reconciliation has been run for this upload" })],
      }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.l5_supporting_evidence.state).not.toBe("failed");
  });

  it("L5 NO_EVIDENCE does not block an otherwise-eligible certification", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_B,
      authoritative: row({
        upload_id: UPLOAD_B,
        exceptions: [exc({ code: "L5_SUPPORTING_EVIDENCE", layer: 5, severity: "info", message: "NO_EVIDENCE: no meaningful supporting evidence was available to evaluate" })],
      }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.l5_supporting_evidence.state).not.toBe("failed");
  });

  it("L6 NO_PRIOR does not block an otherwise-eligible certification", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_B,
      authoritative: row({
        upload_id: UPLOAD_B,
        exceptions: [exc({ code: "L6_PRIOR_PERIOD_SIGNAL", layer: 6, severity: "info", message: "NO_PRIOR: no authoritative certification exists for period 2024" })],
      }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.l6_prior_period.state).not.toBe("failed");
  });

  it("never lets an L5/L6 entry drive the verdict away from certified, even with severity warning", () => {
    // L5/L6 are informational-only by construction (never severity "error"
    // in practice), but even a "warning" there must never block — only
    // L2-L4 error/warning severities feed into is_blocking/requires_review
    // upstream.
    const result = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: UPLOAD_B,
      authoritative: row({
        upload_id: UPLOAD_B,
        exceptions: [exc({ layer: 5, severity: "warning", message: "Unresolved reconciliation exceptions remain." })],
      }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
  });
});
