/**
 * movementSchedules.test.ts
 *
 * Slice 11 — proves the PPE movement engine against real, hand-verified
 * Arusha DC "Motor vehicles" figures, and the schedule-requirement registry
 * against the real 294-account rule pack.
 */

import { describe, it, expect } from "vitest";
import { buildAssetCategoryMovement, assessScheduleRequirement } from "./movementSchedules";
import type { ClassifiedBalance } from "./statementAggregationEngine";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";
import { ARUSHA_FY2026_BALANCES } from "./arushaFy2026Balances.fixture";

describe("buildAssetCategoryMovement — real Arusha DC 'Motor vehicles' category, FY2026", () => {
  // Verified directly against the raw MUSE exports (codes 61121101, 31121101,
  // 61465101, 23140101) before writing this engine — see the file header of
  // movementSchedules.ts for the roll-forward mechanic this data disproved
  // and what was verified instead.
  const result = buildAssetCategoryMovement({
    categoryLabel: "Motor vehicles",
    openingCost: 1738887102.0,
    cumulativeAdditionsCurrentPeriod: 539123175.0, // FY2026 cumulative-to-date
    cumulativeAdditionsPriorPeriod: {
      state: "KNOWN",
      value: 55661975.0, // FY2025 cumulative-to-date
      source: "PRIOR_TB_WITH_CONFIRMED_MAPPING",
      evidence: [],
    },
    openingAccumulatedDepreciation: 1757627299.03,
    depreciationChargeForPeriod: null, // real finding: FY2026 has zero depreciation postings
    disposalsAtCost: 0,
    disposalsAccumulatedDepreciation: 0,
  });

  it("isolates the period's OWN addition from the cumulative-to-date figure", () => {
    expect(result.additionsForPeriod).toBeCloseTo(483461200.0, 1);
  });

  it("computes closing cost as opening + this period's addition", () => {
    expect(result.closingCost).toBeCloseTo(2222348302.0, 1);
  });

  it("does NOT fabricate a closing accumulated depreciation when no charge was posted this period", () => {
    expect(result.closingAccumulatedDepreciation).toBeNull();
    expect(result.netBookValueClosing).toBeNull();
    expect(result.dataGaps).toContainEqual(
      expect.stringContaining("No depreciation charge posted for this period"),
    );
  });

  it("still computes opening NBV from known opening figures, even though closing NBV is blocked", () => {
    expect(result.netBookValueOpening).toBeCloseTo(1738887102.0 - 1757627299.03, 1);
  });

  it("with a real prior-period depreciation charge (FY2025's own real figure), closing accumulated depreciation IS computed", () => {
    const withCharge = buildAssetCategoryMovement({
      categoryLabel: "Motor vehicles",
      openingCost: 1738887102.0,
      cumulativeAdditionsCurrentPeriod: 55661975.0,
      cumulativeAdditionsPriorPeriod: { state: "ZERO", value: 0, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] },
      openingAccumulatedDepreciation: 1757627299.03 - 215203033.0, // back out FY2025's real charge to get a plausible prior opening
      depreciationChargeForPeriod: 215203033.0, // real FY2025 charge
      disposalsAtCost: 0,
      disposalsAccumulatedDepreciation: 0,
    });
    expect(withCharge.closingAccumulatedDepreciation).toBeCloseTo(1757627299.03, 1);
    expect(withCharge.netBookValueClosing).not.toBeNull();
    expect(withCharge.dataGaps).toHaveLength(0);
  });

  it("a MISSING prior-period comparative blocks the period-addition computation, never defaults it to the full cumulative figure", () => {
    const blocked = buildAssetCategoryMovement({
      categoryLabel: "Motor vehicles",
      openingCost: 1738887102.0,
      cumulativeAdditionsCurrentPeriod: 539123175.0,
      cumulativeAdditionsPriorPeriod: { state: "MISSING", source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] },
      openingAccumulatedDepreciation: 1757627299.03,
      depreciationChargeForPeriod: null,
      disposalsAtCost: 0,
      disposalsAccumulatedDepreciation: 0,
    });
    expect(blocked.additionsForPeriod).toBeNull();
    expect(blocked.closingCost).toBeNull();
    expect(blocked.dataGaps.some((g) => g.includes("MISSING"))).toBe(true);
  });
});

describe("assessScheduleRequirement — real Arusha DC FY2026 rule pack + balances", () => {
  const RULE_BY_CODE = new Map(TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((r) => [r.naturalAccountCode, r]));
  const balances: ClassifiedBalance[] = ARUSHA_FY2026_BALANCES.map((b) => {
    const rule = RULE_BY_CODE.get(b.code)!;
    return {
      naturalAccountCode: b.code,
      accountNature: rule.accountNature,
      presentationCode: rule.presentationCode,
      debitAmount: b.debit,
      creditAmount: b.credit,
    };
  });

  it("PPE_ASSET_MOVEMENT is REQUIRED — real, large PPE balances exist", () => {
    const assessment = assessScheduleRequirement("PPE_ASSET_MOVEMENT", balances, 1_000_000);
    expect(assessment.status).toBe("REQUIRED");
    expect(assessment.materialBalance).toBeGreaterThan(1_000_000);
  });

  it("BORROWINGS_MOVEMENT is NOT_APPLICABLE — a TB could represent a borrowing, Arusha DC's real data just has none (Slice 10 finding)", () => {
    const assessment = assessScheduleRequirement("BORROWINGS_MOVEMENT", balances, 1_000_000);
    expect(assessment.status).toBe("NOT_APPLICABLE");
  });

  it("BUDGET_TO_ACTUAL_SCHEDULE is UNASSESSABLE_FROM_TB regardless of balances — a TB alone never proves what was budgeted", () => {
    const assessment = assessScheduleRequirement("BUDGET_TO_ACTUAL_SCHEDULE", balances, 0);
    expect(assessment.status).toBe("UNASSESSABLE_FROM_TB");
  });

  it("an absent schedule type (zero relevant accounts, but real TB-derivable in principle) is NOT_APPLICABLE, not REQUIRED", () => {
    // INTANGIBLES_MOVEMENT has an empty presentationCode list (no real
    // evidence), but since it's not in NEVER_TB_DERIVABLE, it resolves via
    // the balance-count path — zero accounts -> NOT_APPLICABLE, honestly.
    const assessment = assessScheduleRequirement("INTANGIBLES_MOVEMENT", balances, 0);
    expect(assessment.status).toBe("NOT_APPLICABLE");
  });

  it("does not block or throw for any real schedule type — advisory only (Section XIV)", () => {
    const allTypes: Array<Parameters<typeof assessScheduleRequirement>[0]> = [
      "PPE_ASSET_MOVEMENT", "INVESTMENT_PROPERTY_MOVEMENT", "INTANGIBLES_MOVEMENT",
      "WORK_IN_PROGRESS_MOVEMENT", "DEFERRED_INCOME_MOVEMENT", "CAPITAL_GRANTS_MOVEMENT",
      "RECEIVABLES_ECL_MOVEMENT", "INVENTORIES_MOVEMENT", "BORROWINGS_MOVEMENT",
      "EMPLOYEE_BENEFITS_SCHEDULE", "COMMITMENTS_SCHEDULE", "RELATED_PARTIES_SCHEDULE",
      "BUDGET_TO_ACTUAL_SCHEDULE",
    ];
    for (const t of allTypes) {
      expect(() => assessScheduleRequirement(t, balances, 1_000_000)).not.toThrow();
    }
  });
});
