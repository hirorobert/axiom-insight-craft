/**
 * entityContext.test.ts
 *
 * Slice 1 — proves the pure EntityAccountingContext contracts hold their
 * shape and safe defaults. No inference logic exists yet (Slice 2); these
 * tests only cover the type/helper layer itself.
 */

import { describe, it, expect } from "vitest";
import {
  unknownProvenance,
  emptyEntityAccountingContext,
  type EntityClass,
  type ReportingFramework,
  type Provenance,
} from "./entityContext";

describe("unknownProvenance", () => {
  it("carries NONE confidence and UNKNOWN source with no evidence", () => {
    const p = unknownProvenance<EntityClass>("UNKNOWN");
    expect(p.value).toBe("UNKNOWN");
    expect(p.confidence).toBe("NONE");
    expect(p.source).toBe("UNKNOWN");
    expect(p.evidence).toEqual([]);
    expect(p.confirmedBy).toBeUndefined();
    expect(p.confirmedAt).toBeUndefined();
  });

  it("preserves whatever value it is given, even a non-UNKNOWN one", () => {
    // unknownProvenance names the confidence state, not the value itself —
    // callers may seed it with a concrete value pending confirmation.
    const p = unknownProvenance<ReportingFramework>("IPSAS_ACCRUAL");
    expect(p.value).toBe("IPSAS_ACCRUAL");
    expect(p.confidence).toBe("NONE");
  });
});

describe("emptyEntityAccountingContext", () => {
  it("defaults every dimension to UNKNOWN with NONE confidence", () => {
    const ctx = emptyEntityAccountingContext();
    expect(ctx.jurisdiction).toBe("UNKNOWN");
    for (const dim of [
      ctx.entityClass,
      ctx.ownershipClass,
      ctx.reportingFramework,
      ctx.accountingBasis,
      ctx.sourceSystem,
    ]) {
      expect(dim.value).toBe("UNKNOWN");
      expect(dim.confidence).toBe("NONE");
      expect(dim.evidence).toEqual([]);
    }
  });

  it("accepts an explicit jurisdiction while leaving every other dimension UNKNOWN", () => {
    const ctx = emptyEntityAccountingContext("TZ");
    expect(ctx.jurisdiction).toBe("TZ");
    expect(ctx.reportingFramework.value).toBe("UNKNOWN");
    expect(ctx.entityClass.value).toBe("UNKNOWN");
  });

  it("never lets one dimension's default leak into another (C1/C2/C7 orthogonality)", () => {
    // A GOVERNMENT-owned, UNKNOWN-framework context must not silently
    // resolve reportingFramework to IPSAS_ACCRUAL just because a caller
    // later sets ownershipClass. This test documents the invariant at the
    // contract level: setting one Provenance<T> field never touches another.
    const ctx = emptyEntityAccountingContext("TZ");
    const withOwnership: typeof ctx = {
      ...ctx,
      ownershipClass: {
        value: "GOVERNMENT_OWNED",
        confidence: "HIGH",
        source: "LEGAL_FORM_EVIDENCE",
        evidence: [{ source: "LEGAL_FORM_EVIDENCE", detail: "Registered as a parastatal" }],
      },
    };
    expect(withOwnership.reportingFramework.value).toBe("UNKNOWN");
    expect(withOwnership.reportingFramework.confidence).toBe("NONE");
  });
});

describe("Provenance<T> shape", () => {
  it("supports an explicit professional confirmation", () => {
    const confirmed: Provenance<ReportingFramework> = {
      value: "IPSAS_ACCRUAL",
      confidence: "HIGH",
      source: "PRIOR_PROFESSIONAL_CONFIRMATION",
      evidence: [
        {
          source: "PRIOR_PROFESSIONAL_CONFIRMATION",
          detail: "Confirmed against FY2025 audited financial statements",
          ref: "upload-fy2025-audited",
        },
      ],
      confirmedBy: "firm-member-123",
      confirmedAt: "2026-08-10T00:00:00Z",
    };
    expect(confirmed.confirmedBy).toBe("firm-member-123");
    expect(confirmed.evidence).toHaveLength(1);
  });
});
