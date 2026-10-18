/**
 * comparativeEvidence.test.ts
 *
 * Slice 7 — proves the comparative source-tier hierarchy, the C4-mandated
 * explicit states (never a fabricated zero), and mapping-drift detection.
 * Presence changes are proven on invented code lists for a two-period pair
 * (codes are MUSE natural account codes; which code appears in which period
 * is invented), and the mapping-drift mechanism on a synthetic code.
 */

import { describe, it, expect } from "vitest";
import {
  resolveComparativeSourceTier,
  resolveComparativeAmount,
  detectMappingDrift,
  detectPresenceChanges,
  type ComparativeLineLookup,
} from "./comparativeEvidence";

describe("resolveComparativeSourceTier — Section XI hierarchy", () => {
  it("prior audited signed statements outrank everything else, even when a prior TB is also available", () => {
    const tier = resolveComparativeSourceTier({
      priorAuditedSignedStatements: { ref: "fs-2025-signed", detail: "FY2025 audited statements" },
      priorTbWithConfirmedMapping: { ref: "upload-2025", detail: "FY2025 TB" },
    });
    expect(tier).toBe("PRIOR_AUDITED_SIGNED_STATEMENTS");
  });

  it("prior TB does not become a hard prerequisite — a certified SAFF close alone resolves without it", () => {
    const tier = resolveComparativeSourceTier({
      priorCertifiedSaffClose: { ref: "close-2025", detail: "FY2025 certified close" },
    });
    expect(tier).toBe("PRIOR_CERTIFIED_SAFF_CLOSE");
  });

  it("no evidence at all resolves to UNAVAILABLE, never a guessed tier", () => {
    expect(resolveComparativeSourceTier({})).toBe("UNAVAILABLE");
  });
});

describe("resolveComparativeAmount — C4: never a fabricated zero", () => {
  const fixture: Record<string, number> = {
    "11640172": 1_104_996_250.4, // invented prior-period figure
    "62123115": 0, // a genuinely zero balance, still KNOWN
  };
  const lookup: ComparativeLineLookup = { find: (code) => fixture[code] };

  it("a found non-zero value is KNOWN, with source and evidence attached", () => {
    const amt = resolveComparativeAmount("11640172", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "upload-fy2025");
    expect(amt.state).toBe("KNOWN");
    if (amt.state === "KNOWN") expect(amt.value).toBe(1_104_996_250.4);
    expect(amt.evidence.length).toBeGreaterThan(0);
  });

  it("a found genuine zero is ZERO, distinct from MISSING", () => {
    const amt = resolveComparativeAmount("62123115", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "upload-fy2025");
    expect(amt.state).toBe("ZERO");
    if (amt.state === "ZERO") expect(amt.value).toBe(0);
  });

  it("a tier that resolved but doesn't contain this specific code is MISSING, never silently 0", () => {
    // '13465101 Subvention Capital' is not in the comparative source used
    // here — so when FY2025 comparatives are resolved for a FY2026 trial
    // balance, that code is MISSING.
    const amt = resolveComparativeAmount("13465101", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "upload-fy2025");
    expect(amt.state).toBe("MISSING");
    expect("value" in amt).toBe(false);
  });

  it("no comparative source at all is NOT_APPLICABLE, distinct from MISSING", () => {
    const amt = resolveComparativeAmount("11640172", "UNAVAILABLE", lookup, "n/a");
    expect(amt.state).toBe("NOT_APPLICABLE");
    expect("value" in amt).toBe(false);
    expect("source" in amt).toBe(false);
  });

  it("Scenario 7 proof — a resolved comparative amount carries evidence/source, never an 'approved' flag: prior mapping informs, it does not approve", () => {
    const amt = resolveComparativeAmount("11640172", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "upload-fy2025");
    expect(Object.keys(amt)).not.toContain("approved");
    expect(Object.keys(amt)).not.toContain("approvedBy");
  });
});

describe("detectPresenceChanges — invented FY2025 -> FY2026 comparative pair", () => {
  // Invented presence pattern: 6 codes in both periods, 5 only in FY2025, 4 only in FY2026.
  const fy2025Sample = [
    "11640172", "12110103", "12120107", "13410101", "13410102", "21111101",
    "13465101", "14210104", "22033301", "31221103", "32171201",
  ];
  const fy2026Sample = [
    "11640172", "12110103", "12120107", "13410101", "13410102", "21111101",
    "13465104", "14150101", "31221105", "33182153",
  ];

  const changes = detectPresenceChanges(fy2025Sample, fy2026Sample);

  it("accounts absent from the current period are flagged ABSENT_THIS_PERIOD, not silently dropped", () => {
    const absent = changes.filter((c) => c.change === "ABSENT_THIS_PERIOD").map((c) => c.naturalAccountCode);
    expect([...absent].sort()).toEqual(["13465101", "14210104", "22033301", "31221103", "32171201"]);
  });

  it("accounts new this period (no FY2025 prior) are flagged NEW_THIS_PERIOD, not given a fabricated prior of 0", () => {
    const added = changes.filter((c) => c.change === "NEW_THIS_PERIOD").map((c) => c.naturalAccountCode);
    expect([...added].sort()).toEqual(["13465104", "14150101", "31221105", "33182153"]);
  });

  it("every change is reported exactly once — 5 absent + 4 new = 9", () => {
    expect(changes).toHaveLength(9);
  });

  it("accounts present in both periods are not flagged at all", () => {
    const flaggedCodes = new Set(changes.map((c) => c.naturalAccountCode));
    expect(flaggedCodes.has("11640172")).toBe(false);
    expect(flaggedCodes.has("12110103")).toBe(false);
  });
});

describe("detectMappingDrift — mechanism proof (synthetic)", () => {
  it("flags a presentation change between periods for the same account code, without blocking (Section XI: surface, do not auto-block)", () => {
    const flags = detectMappingDrift(
      [{ periodLabel: "FY2025", naturalAccountCode: "99999999", presentationCode: "USE_OF_GOODS_AND_SERVICES" }],
      [{ periodLabel: "FY2026", naturalAccountCode: "99999999", presentationCode: "PROPERTY_PLANT_EQUIPMENT_ADDITIONS" }],
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].message).toContain("Presentation changed from prior audited period");
    expect(flags[0].priorPresentationCode).toBe("USE_OF_GOODS_AND_SERVICES");
    expect(flags[0].currentPresentationCode).toBe("PROPERTY_PLANT_EQUIPMENT_ADDITIONS");
  });

  it("does not flag unchanged presentation for a code present in both periods", () => {
    const prior = [{ periodLabel: "FY2025", naturalAccountCode: "11640172", presentationCode: "LEVIES" }];
    const current = [{ periodLabel: "FY2026", naturalAccountCode: "11640172", presentationCode: "LEVIES" }];
    expect(detectMappingDrift(prior, current)).toHaveLength(0);
  });

  it("a brand-new account (no prior entry at all) is not flagged as drift — that is a presence change, not a reclassification", () => {
    const flags = detectMappingDrift(
      [],
      [{ periodLabel: "FY2026", naturalAccountCode: "14150103", presentationCode: "OWN_SOURCE_REVENUE_EXCHANGE_STATUS_UNCONFIRMED" }],
    );
    expect(flags).toHaveLength(0);
  });
});
