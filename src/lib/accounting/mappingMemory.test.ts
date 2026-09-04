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
  resolveMappingMemorySuggestion,
  type MappingMemoryRecord,
  type HistoricalDecisionContext,
  type MappingMemoryQuery,
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
      // decisionKind supplied so this test isolates exactly the confirmedBy/
      // confirmedAt requirement — Ω∞ Phase 8 adds a SEPARATE decisionKind
      // requirement, covered in its own describe block below.
      record({ auditStatus: "user_approved_current", decisionKind: "ORIGINAL_JUDGEMENT" }),
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
        decisionKind: "ORIGINAL_JUDGEMENT",
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

// ── Ω∞ Phase 8 — TS/DB contract-drift reconciliation (decisionKind/suggestionShown) ──

describe("validateMappingMemoryRecord — Ω∞ Phase 8: decisionKind/suggestionShown mirror migration 20260813151156", () => {
  it("a human decision without decisionKind fails validation", () => {
    const result = validateMappingMemoryRecord(
      record({
        auditStatus: "user_approved_current",
        confirmedBy: "firm-member-1",
        confirmedAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("decisionKind"))).toBe(true);
  });

  it("ACCEPTED_SUGGESTION without suggestionShown fails — proposal_type != professional decision", () => {
    const result = validateMappingMemoryRecord(
      record({
        auditStatus: "user_approved_current",
        confirmedBy: "firm-member-1",
        confirmedAt: "2026-01-01T00:00:00Z",
        decisionKind: "ACCEPTED_SUGGESTION",
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("ACCEPTED_SUGGESTION with suggestionShown passes", () => {
    const result = validateMappingMemoryRecord(
      record({
        auditStatus: "user_approved_current",
        confirmedBy: "firm-member-1",
        confirmedAt: "2026-01-01T00:00:00Z",
        decisionKind: "ACCEPTED_SUGGESTION",
        suggestionShown: { presentationCode: "LEVIES", ruleId: "R1", ruleVersion: "v1" },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("ORIGINAL_JUDGEMENT with a suggestionShown present fails — asserts none was shown", () => {
    const result = validateMappingMemoryRecord(
      record({
        auditStatus: "user_approved_current",
        confirmedBy: "firm-member-1",
        confirmedAt: "2026-01-01T00:00:00Z",
        decisionKind: "ORIGINAL_JUDGEMENT",
        suggestionShown: { presentationCode: "LEVIES" },
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("MACHINE_RULE with a confirmedBy fails — no deciding professional for a machine-only row", () => {
    const result = validateMappingMemoryRecord(
      record({ auditStatus: "system_rule", decisionKind: "MACHINE_RULE", confirmedBy: "firm-member-1" }),
    );
    expect(result.valid).toBe(false);
  });

  it("MACHINE_RULE with no confirmedBy passes", () => {
    const result = validateMappingMemoryRecord(record({ auditStatus: "system_rule", decisionKind: "MACHINE_RULE" }));
    expect(result.valid).toBe(true);
  });
});

// ── Ω∞ Phase 8 — resolveMappingMemorySuggestion ──────────────────────────────

function decision(overrides: Partial<HistoricalDecisionContext> = {}): HistoricalDecisionContext {
  return {
    companyId: "company-1",
    uploadId: "upload-1",
    periodYear: 2025,
    reviewAccountKey: "11640172",
    sequenceNo: 100,
    decisionAction: "USER_MANUAL_CLASSIFICATION",
    proposalType: "NONE",
    classification: "current_assets",
    frameworkProvenance: "DIRECT",
    reportingFramework: "IPSAS_ACCRUAL",
    sourceSystemProvenance: "DIRECT",
    sourceSystem: "MUSE",
    certificationRelationship: "LINKED_TO_CERTIFIED_UPLOAD",
    ...overrides,
  };
}

function query(overrides: Partial<MappingMemoryQuery> = {}): MappingMemoryQuery {
  return {
    companyId: "company-1",
    reviewAccountKey: "11640172",
    targetReportingFramework: "IPSAS_ACCRUAL",
    targetSourceSystem: "MUSE",
    ...overrides,
  };
}

describe("resolveMappingMemorySuggestion — exact history, eligible", () => {
  it("same company + exact account identity + valid decision + known compatible period/framework/source -> eligible", () => {
    const r = resolveMappingMemorySuggestion([decision()], query());
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
    expect(r.suggestedClassification).toBe("current_assets");
    expect(r.confidenceSource).toBe("PRIOR_PROFESSIONAL_CONFIRMATION");
    expect(r.confidence).toBe("HIGH");
    expect(r.certificationRelationship).toBe("LINKED_TO_CERTIFIED_UPLOAD");
  });

  it("USER_ACCEPTED_SUGGESTION is eligible professional history", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ decisionAction: "USER_ACCEPTED_SUGGESTION", proposalType: "MACHINE_SUGGESTION" })],
      query(),
    );
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
  });

  it("USER_MANUAL_CLASSIFICATION is eligible professional history", () => {
    const r = resolveMappingMemorySuggestion([decision({ decisionAction: "USER_MANUAL_CLASSIFICATION" })], query());
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
  });
});

describe("resolveMappingMemorySuggestion — company isolation", () => {
  it("a different company never matches", () => {
    const r = resolveMappingMemorySuggestion([decision({ companyId: "company-2" })], query());
    expect(r.result).toBe("NO_HISTORY");
  });

  it("mixed-company input: only the target company's history is ever considered, no leakage", () => {
    const foreign = decision({ companyId: "company-2", classification: "revenue", sequenceNo: 999 });
    const own = decision({ companyId: "company-1", classification: "current_assets", sequenceNo: 1 });
    const r = resolveMappingMemorySuggestion([foreign, own], query());
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
    expect(r.suggestedClassification).toBe("current_assets");
  });
});

describe("resolveMappingMemorySuggestion — period authority", () => {
  it("unknown period fails closed to PERIOD_UNAVAILABLE, never guessed", () => {
    const r = resolveMappingMemorySuggestion([decision({ periodYear: null })], query());
    expect(r.result).toBe("PERIOD_UNAVAILABLE");
  });

  it("multiple known periods: the highest sequence_no wins, not the highest periodYear or array position", () => {
    const older = decision({ periodYear: 2024, sequenceNo: 5, classification: "operating_expenses" });
    const newer = decision({ periodYear: 2023, sequenceNo: 50, classification: "current_assets" }); // earlier period, later sequence
    const r = resolveMappingMemorySuggestion([older, newer], query());
    expect(r.suggestedClassification).toBe("current_assets");
    expect(r.sourcePeriodYear).toBe(2023);
  });
});

describe("resolveMappingMemorySuggestion — reversal semantics", () => {
  it("classification A then later classification B -> suggestion is B, never A resurrected", () => {
    const a = decision({ sequenceNo: 1, classification: "operating_expenses" });
    const b = decision({ sequenceNo: 2, classification: "current_assets" });
    const forward = resolveMappingMemorySuggestion([a, b], query());
    const reversed = resolveMappingMemorySuggestion([b, a], query());
    expect(forward.suggestedClassification).toBe("current_assets");
    expect(reversed.suggestedClassification).toBe("current_assets");
  });
});

describe("resolveMappingMemorySuggestion — machine vs professional", () => {
  it("only MACHINE_RULE-tagged history (never professionally touched) -> NOT_PROFESSIONALLY_DECIDED", () => {
    const r = resolveMappingMemorySuggestion([decision({ decisionKind: "MACHINE_RULE" })], query());
    expect(r.result).toBe("NOT_PROFESSIONALLY_DECIDED");
  });

  it("a MACHINE_RULE row is ignored in favor of a real professional act even if it has a higher sequenceNo", () => {
    const machine = decision({ decisionKind: "MACHINE_RULE", sequenceNo: 999, classification: "revenue" });
    const human = decision({ sequenceNo: 1, classification: "current_assets" });
    const r = resolveMappingMemorySuggestion([machine, human], query());
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
    expect(r.suggestedClassification).toBe("current_assets");
  });
});

describe("resolveMappingMemorySuggestion — non-reporting", () => {
  it("a prior MARK_NON_REPORTING_ACCOUNT decision surfaces as suggestion only, never as an exclusion field", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ decisionAction: "MARK_NON_REPORTING_ACCOUNT", classification: undefined })],
      query(),
    );
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
    expect(r.suggestsNonReporting).toBe(true);
    expect(r.suggestedClassification).toBeUndefined();
  });
});

describe("resolveMappingMemorySuggestion — framework provenance", () => {
  it("DIRECT + compatible framework yields HIGH confidence", () => {
    const r = resolveMappingMemorySuggestion([decision({ frameworkProvenance: "DIRECT", reportingFramework: "IPSAS_ACCRUAL" })], query({ targetReportingFramework: "IPSAS_ACCRUAL" }));
    expect(r.confidence).toBe("HIGH");
  });

  it("DIRECT + incompatible framework fails closed to FRAMEWORK_INCOMPATIBLE", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ frameworkProvenance: "DIRECT", reportingFramework: "IPSAS_ACCRUAL" })],
      query({ targetReportingFramework: "IFRS_FOR_SMES" }),
    );
    expect(r.result).toBe("FRAMEWORK_INCOMPATIBLE");
  });

  it("CORRELATED_ONLY framework provenance is allowed but capped at MEDIUM confidence — never promoted to DIRECT strength", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ frameworkProvenance: "CORRELATED_ONLY", reportingFramework: undefined })],
      query(),
    );
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
    expect(r.confidence).toBe("MEDIUM");
    expect(r.frameworkProvenance).toBe("CORRELATED_ONLY");
  });

  it("UNAVAILABLE framework provenance is allowed but capped at LOW confidence, never blocked outright", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ frameworkProvenance: "UNAVAILABLE", reportingFramework: undefined })],
      query(),
    );
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
    expect(r.confidence).toBe("LOW");
  });
});

describe("resolveMappingMemorySuggestion — source-system provenance", () => {
  it("DIRECT + compatible source system yields HIGH confidence", () => {
    const r = resolveMappingMemorySuggestion([decision({ sourceSystemProvenance: "DIRECT", sourceSystem: "MUSE" })], query({ targetSourceSystem: "MUSE" }));
    expect(r.confidence).toBe("HIGH");
  });

  it("DIRECT + incompatible source system fails closed to SOURCE_SYSTEM_INCOMPATIBLE", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ sourceSystemProvenance: "DIRECT", sourceSystem: "MUSE" })],
      query({ targetSourceSystem: "QUICKBOOKS" }),
    );
    expect(r.result).toBe("SOURCE_SYSTEM_INCOMPATIBLE");
  });

  it("CORRELATED_ONLY source-system provenance is allowed but capped at MEDIUM confidence", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ sourceSystemProvenance: "CORRELATED_ONLY", sourceSystem: undefined })],
      query(),
    );
    expect(r.confidence).toBe("MEDIUM");
  });

  it("UNAVAILABLE source-system provenance is allowed but capped at LOW confidence", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ sourceSystemProvenance: "UNAVAILABLE", sourceSystem: undefined })],
      query(),
    );
    expect(r.confidence).toBe("LOW");
  });

  it("overall confidence is the WEAKER of framework and source-system provenance", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ frameworkProvenance: "DIRECT", sourceSystemProvenance: "UNAVAILABLE", sourceSystem: undefined })],
      query(),
    );
    expect(r.confidence).toBe("LOW");
  });
});

describe("resolveMappingMemorySuggestion — certification relationship (never claims the decision itself was certified)", () => {
  it("linked to a certified upload is echoed as such", () => {
    const r = resolveMappingMemorySuggestion([decision({ certificationRelationship: "LINKED_TO_CERTIFIED_UPLOAD" })], query());
    expect(r.certificationRelationship).toBe("LINKED_TO_CERTIFIED_UPLOAD");
  });

  it("linked to an uncertified upload is echoed truthfully, and does not block eligibility", () => {
    const r = resolveMappingMemorySuggestion([decision({ certificationRelationship: "LINKED_TO_UNCERTIFIED_UPLOAD" })], query());
    expect(r.result).toBe("SUGGESTION_ELIGIBLE");
    expect(r.certificationRelationship).toBe("LINKED_TO_UNCERTIFIED_UPLOAD");
  });

  it("unknown certification relationship is echoed as UNKNOWN, never upgraded to certified", () => {
    const r = resolveMappingMemorySuggestion([decision({ certificationRelationship: "UNKNOWN" })], query());
    expect(r.certificationRelationship).toBe("UNKNOWN");
  });
});

describe("resolveMappingMemorySuggestion — conflicts", () => {
  it("a conflicting current signal is surfaced, never auto-resolved", () => {
    const r = resolveMappingMemorySuggestion(
      [decision()],
      query({ conflictingCurrentEvidence: [{ description: "Tier-2 exact-code rule currently matches operating_expenses" }] }),
    );
    expect(r.result).toBe("SUGGESTION_ELIGIBLE"); // still offered as evidence
    expect(r.conflicts).toEqual(["Tier-2 exact-code rule currently matches operating_expenses"]);
    expect(r.suggestedClassification).toBe("current_assets"); // NOT overridden by the conflicting signal
  });

  it("no conflicting evidence supplied -> empty conflicts array, not undefined", () => {
    const r = resolveMappingMemorySuggestion([decision()], query());
    expect(r.conflicts).toEqual([]);
  });
});

describe("resolveMappingMemorySuggestion — determinism", () => {
  it("input order never changes the result", () => {
    const a = decision({ sequenceNo: 1, classification: "operating_expenses" });
    const b = decision({ sequenceNo: 3, classification: "revenue" });
    const c = decision({ sequenceNo: 2, classification: "current_assets" });
    const forward = resolveMappingMemorySuggestion([a, b, c], query());
    const reversed = resolveMappingMemorySuggestion([c, b, a], query());
    const shuffled = resolveMappingMemorySuggestion([b, a, c], query());
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(shuffled);
    expect(forward.suggestedClassification).toBe("revenue");
  });

  it("duplicate rows (identical sequence_no) fail closed to AMBIGUOUS_EQUAL_AUTHORITY rather than picking one arbitrarily", () => {
    const one = decision({ sequenceNo: 7, classification: "current_assets" });
    const two = decision({ sequenceNo: 7, classification: "revenue" });
    const r = resolveMappingMemorySuggestion([one, two], query());
    expect(r.result).toBe("AMBIGUOUS_EQUAL_AUTHORITY");
  });
});

describe("resolveMappingMemorySuggestion — no history / no authority", () => {
  it("empty history -> NO_HISTORY", () => {
    const r = resolveMappingMemorySuggestion([], query());
    expect(r.result).toBe("NO_HISTORY");
  });

  it("a different exact account identity never matches (no fuzzy identity in this resolver)", () => {
    const r = resolveMappingMemorySuggestion(
      [decision({ reviewAccountKey: "99999999" })],
      query({ reviewAccountKey: "11640172" }),
    );
    expect(r.result).toBe("NO_HISTORY");
  });
});

describe("resolveMappingMemorySuggestion — authority boundary (this module writes nothing)", () => {
  it("the resolver is a pure function of its inputs — calling it twice with the same input never mutates or has side effects", () => {
    const input = [decision()];
    const q = query();
    const first = resolveMappingMemorySuggestion(input, q);
    const second = resolveMappingMemorySuggestion(input, q);
    expect(first).toEqual(second);
    expect(input).toHaveLength(1); // input array untouched
  });
});
