import { describe, it, expect } from "vitest";
import {
  computeCertificationReadiness,
  type TbCertificationRow,
  type TbCertificationExceptionRecord,
} from "./computeCertificationReadiness";

function row(overrides: Partial<TbCertificationRow>): TbCertificationRow {
  return {
    id: "cert-1",
    sequence_no: 1,
    company_id: "company-1",
    upload_id: "upload-1",
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
      authoritative: null,
      latestForUpload: null,
      fetchFailed: true,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("pending");
    expect(result.verdict).not.toBe("certified");
  });

  it("fetchFailed wins even if authoritative somehow carries a value", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      authoritative: row({}),
      latestForUpload: null,
      fetchFailed: true,
    });
    expect(result.verdict).toBe("unknown");
  });
});

describe("computeCertificationReadiness — never certified yet", () => {
  it("returns pending when the upload exists but no certification was ever committed", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      authoritative: null,
      latestForUpload: null,
    });
    expect(result.verdict).toBe("pending");
    expect(result.headline).toBe("Pre-flight check running");
  });
});

describe("computeCertificationReadiness — certified, clean", () => {
  it("marks L1-L4 passed and L5/L6 pending when no exceptions were recorded at all (pre-Slice-4A certification)", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      authoritative: row({ exceptions: [] }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
    expect(result.blocker).toBeNull();
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.l1_structure.state).toBe("passed");
    expect(byId.l2_data_quality.state).toBe("passed");
    expect(byId.l3_arithmetic.state).toBe("passed");
    expect(byId.l4_classification.state).toBe("passed");
    // L5/L6 genuinely absent from an old certification — NOT_COMPUTED, not "clean".
    expect(byId.l5_supporting_evidence.state).toBe("pending");
    expect(byId.l6_prior_period.state).toBe("pending");
  });

  it("stays certified when L5/L6 carry only informational entries", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      authoritative: row({
        exceptions: [
          exc({ code: "L5_SUPPORTING_EVIDENCE", layer: 5, severity: "info", message: "No supporting evidence available." }),
          exc({ code: "L6_PRIOR_PERIOD_SIGNAL", layer: 6, severity: "info", message: "No prior period on record." }),
        ],
      }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.l5_supporting_evidence.state).toBe("passed");
    expect(byId.l6_prior_period.state).toBe("passed");
  });

  it("never lets an L5/L6 entry drive the verdict away from certified, even with severity warning", () => {
    // L5/L6 are informational-only by construction (never severity "error"),
    // but even a "warning" there must never block — only L2-L4 error/warning
    // severities feed into is_blocking/requires_review upstream.
    const result = computeCertificationReadiness({
      uploadExists: true,
      authoritative: row({
        exceptions: [exc({ layer: 5, severity: "warning", message: "Unresolved reconciliation exceptions remain." })],
      }),
      latestForUpload: null,
    });
    expect(result.verdict).toBe("certified");
  });
});

describe("computeCertificationReadiness — blocked", () => {
  it("reports blocked with the first error message when the latest certification is_blocking", () => {
    const result = computeCertificationReadiness({
      uploadExists: true,
      authoritative: null,
      latestForUpload: row({
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
      authoritative: null,
      latestForUpload: row({
        is_blocking: false,
        requires_review: true,
        exceptions: [exc({ layer: 4, severity: "warning", message: "3 accounts still need a mapping decision." })],
      }),
    });
    expect(result.verdict).toBe("review");
    expect(result.blocker).toBe("3 accounts still need a mapping decision.");
  });
});

describe("computeCertificationReadiness — stale (the case with no legacy equivalent)", () => {
  it("reports stale when the latest certification was eligible at commit time but the authoritative RPC found nothing", () => {
    // This is exactly the get_authoritative_certification source_file_hash-
    // drift scenario: latestForUpload is clean (not blocking, not review)
    // yet `authoritative` is null — the only way that combination happens.
    const result = computeCertificationReadiness({
      uploadExists: true,
      authoritative: null,
      latestForUpload: row({ is_blocking: false, requires_review: false, exceptions: [] }),
    });
    expect(result.verdict).toBe("stale");
    expect(result.blocker).toMatch(/changed since it was last certified/i);
  });

  it("is distinguishable from both 'pending' (never certified) and 'certified'", () => {
    const stale = computeCertificationReadiness({
      uploadExists: true,
      authoritative: null,
      latestForUpload: row({ is_blocking: false, requires_review: false }),
    });
    const neverCertified = computeCertificationReadiness({
      uploadExists: true,
      authoritative: null,
      latestForUpload: null,
    });
    expect(stale.verdict).not.toBe(neverCertified.verdict);
    expect(stale.verdict).not.toBe("certified");
  });
});

describe("computeCertificationReadiness — L1 is never itself a failure source", () => {
  it("always reports L1 passed whenever any certification row exists, regardless of outcome", () => {
    const blocked = computeCertificationReadiness({
      uploadExists: true,
      authoritative: null,
      latestForUpload: row({ is_blocking: true, exceptions: [exc({ layer: 2, severity: "error", message: "bad" })] }),
    });
    const byId = Object.fromEntries(blocked.checks.map((c) => [c.id, c]));
    expect(byId.l1_structure.state).toBe("passed");
  });
});
