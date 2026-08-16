/**
 * mappingMemory.test.ts
 *
 * Slice 12 — proves the priority evidence ladder, the confirmed-fields
 * validation mirroring the DB CHECK constraint, and the structural
 * prohibition on treating a prior period's confirmation as this year's.
 */

import { describe, it, expect } from "vitest";
import {
  auditStatusPriority,
  validateMappingMemoryRecord,
  selectAuthoritativeMapping,
  findEffectiveMappingForPeriod,
  type MappingMemoryRecord,
} from "./mappingMemory";

function record(overrides: Partial<MappingMemoryRecord>): MappingMemoryRecord {
  return {
    companyId: "company-1",
    sourceSystem: "MUSE",
    naturalAccountCode: "11640172",
    normalizedAccountName: "levy service",
    reportingFramework: "IPSAS_ACCRUAL",
    accountNature: "REVENUE",
    presentationCode: "LEVIES",
    effectivePeriodYear: 2026,
    evidenceSource: "SOURCE_SYSTEM_SIGNATURE",
    auditStatus: "system_rule",
    ...overrides,
  };
}

describe("auditStatusPriority — Section XV ladder", () => {
  it("CAG external audit outranks everything else", () => {
    expect(auditStatusPriority("cag_external_audited")).toBeGreaterThan(
      auditStatusPriority("saff_professionally_approved"),
    );
    expect(auditStatusPriority("saff_professionally_approved")).toBeGreaterThan(
      auditStatusPriority("user_approved_current"),
    );
    expect(auditStatusPriority("user_approved_current")).toBeGreaterThan(
      auditStatusPriority("system_rule"),
    );
  });
});

describe("validateMappingMemoryRecord — mirrors the DB CHECK constraint", () => {
  it("system_rule needs no confirmedBy/confirmedAt", () => {
    const result = validateMappingMemoryRecord(record({ auditStatus: "system_rule" }));
    expect(result.valid).toBe(true);
  });

  it("any non-system-rule status without confirmedBy/confirmedAt fails validation", () => {
    const result = validateMappingMemoryRecord(
      record({ auditStatus: "user_approved_current" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2); // both confirmedBy and confirmedAt missing
  });

  it("a fully-confirmed record passes", () => {
    const result = validateMappingMemoryRecord(
      record({
        auditStatus: "cag_external_audited",
        confirmedBy: "firm-member-1",
        confirmedAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("an out-of-range effectivePeriodYear is rejected", () => {
    const result = validateMappingMemoryRecord(record({ effectivePeriodYear: 1899 }));
    expect(result.valid).toBe(false);
  });
});

describe("selectAuthoritativeMapping — Section XV priority selection", () => {
  it("a professional confirmation beats a system rule for the same account", () => {
    const systemRule = record({ auditStatus: "system_rule" });
    const userApproved = record({
      auditStatus: "user_approved_current",
      confirmedBy: "firm-member-1",
      confirmedAt: "2026-01-01T00:00:00Z",
    });
    expect(selectAuthoritativeMapping([systemRule, userApproved])).toBe(userApproved);
  });

  it("CAG external audit beats a SAFF-professional approval", () => {
    const saffApproved = record({
      auditStatus: "saff_professionally_approved",
      confirmedBy: "firm-member-1",
      confirmedAt: "2026-01-01T00:00:00Z",
    });
    const cagAudited = record({
      auditStatus: "cag_external_audited",
      confirmedBy: "firm-member-2",
      confirmedAt: "2025-06-01T00:00:00Z", // earlier in time, but higher authority
    });
    expect(selectAuthoritativeMapping([saffApproved, cagAudited])).toBe(cagAudited);
  });

  it("at the SAME audit_status, the more recent confirmation wins (a genuine later correction)", () => {
    const earlier = record({
      auditStatus: "user_approved_current",
      confirmedBy: "firm-member-1",
      confirmedAt: "2026-01-01T00:00:00Z",
    });
    const later = record({
      auditStatus: "user_approved_current",
      confirmedBy: "firm-member-2",
      confirmedAt: "2026-06-01T00:00:00Z",
    });
    expect(selectAuthoritativeMapping([earlier, later])).toBe(later);
  });

  it("returns null for an empty candidate list, never a fabricated default", () => {
    expect(selectAuthoritativeMapping([])).toBeNull();
  });
});

describe("findEffectiveMappingForPeriod — Section XV: prior period never silently becomes this year's approval", () => {
  it("a confirmation for FY2025 is invisible to a FY2026 lookup on the same account code", () => {
    const fy2025Confirmation = record({
      effectivePeriodYear: 2025,
      auditStatus: "cag_external_audited",
      confirmedBy: "firm-member-1",
      confirmedAt: "2025-08-01T00:00:00Z",
    });
    const result = findEffectiveMappingForPeriod([fy2025Confirmation], "11640172", 2026);
    expect(result).toBeNull();
  });

  it("a confirmation for the matching period IS found, and different account codes never cross-match", () => {
    const fy2026Confirmation = record({ effectivePeriodYear: 2026, naturalAccountCode: "11640172" });
    const otherCode = record({ effectivePeriodYear: 2026, naturalAccountCode: "99999999" });
    const result = findEffectiveMappingForPeriod(
      [fy2026Confirmation, otherCode],
      "11640172",
      2026,
    );
    expect(result).toBe(fy2026Confirmation);
  });
});
