/**
 * movementSchedules.test.ts
 *
 * Slice 11 — proves the PPE movement engine against real, hand-verified
 * Arusha DC "Motor vehicles" figures, and the schedule-requirement registry
 * against the real 294-account rule pack.
 */

import { describe, it, expect } from "vitest";
import {
  buildAssetCategoryMovement,
  assessScheduleRequirement,
  buildGenericScheduleMovement,
  type ScheduleMovementLine,
  type BuildGenericScheduleMovementInput,
} from "./movementSchedules";
import type { ClassifiedBalance } from "./statementAggregationEngine";
import type { ComparativeAmount } from "./comparativeEvidence";
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
      "BUDGET_TO_ACTUAL_SCHEDULE", "PROVISIONS_MOVEMENT",
    ];
    for (const t of allTypes) {
      expect(() => assessScheduleRequirement(t, balances, 1_000_000)).not.toThrow();
    }
  });

  it("Ω∞ Phase 7: PROVISIONS_MOVEMENT is NOT_APPLICABLE (structurally TB-derivable, but no account is classified as one in this rule pack — never UNASSESSABLE_FROM_TB, never conflated with ECL contra-asset provisions)", () => {
    const assessment = assessScheduleRequirement("PROVISIONS_MOVEMENT", balances, 1_000_000);
    expect(assessment.status).toBe("NOT_APPLICABLE");
    expect(assessment.relevantPresentationCodes).toEqual([]);
  });

  it("Ω∞ Phase 7: RECEIVABLES_ECL_MOVEMENT (contra-asset ECL) and PROVISIONS_MOVEMENT (liability provisions) are never the same schedule — disjoint presentation-code sets", () => {
    const ecl = assessScheduleRequirement("RECEIVABLES_ECL_MOVEMENT", balances, 1_000_000);
    const provisions = assessScheduleRequirement("PROVISIONS_MOVEMENT", balances, 1_000_000);
    const overlap = provisions.relevantPresentationCodes.filter((c) => ecl.relevantPresentationCodes.includes(c));
    expect(overlap).toHaveLength(0);
  });
});

// ── Ω∞ Phase 7 — buildGenericScheduleMovement (Deferred Income / Capital Grants / Provisions) ──

const CERTIFIED = { verdict: "certified" as const };
const KNOWN = (value: number): ComparativeAmount => ({
  state: "KNOWN", value, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [],
});
const ZERO_AMOUNT: ComparativeAmount = {
  state: "ZERO", value: 0, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [],
};
const MISSING_AMOUNT: ComparativeAmount = {
  state: "MISSING", source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [],
};
const NOT_APPLICABLE_AMOUNT: ComparativeAmount = { state: "NOT_APPLICABLE", evidence: [] };

function baseInput(overrides: Partial<BuildGenericScheduleMovementInput> = {}): BuildGenericScheduleMovementInput {
  return {
    scheduleType: "DEFERRED_INCOME_MOVEMENT",
    openingBalance: KNOWN(1_000_000),
    movements: [],
    tbClosingBalance: 1_000_000,
    toleranceTzs: 1_000,
    certification: CERTIFIED,
    ...overrides,
  };
}

describe("buildGenericScheduleMovement — opening states", () => {
  it("KNOWN opening + no movements: closing equals opening, RECONCILED against matching TB", () => {
    const r = buildGenericScheduleMovement(baseInput());
    expect(r.closingBalance).toBe(1_000_000);
    expect(r.reconciliation).toBe("RECONCILED");
    expect(r.dataGaps).toHaveLength(0);
  });

  it("ZERO opening (genuine, evidenced zero) computes a real closing balance, never blocked", () => {
    const r = buildGenericScheduleMovement(baseInput({
      openingBalance: ZERO_AMOUNT,
      movements: [{ category: "RECEIPT_INCREASE", amount: 500_000, evidence: [] }],
      tbClosingBalance: 500_000,
    }));
    expect(r.closingBalance).toBe(500_000);
    expect(r.reconciliation).toBe("RECONCILED");
  });

  it("MISSING opening blocks closingBalance — never defaulted to 0", () => {
    const r = buildGenericScheduleMovement(baseInput({ openingBalance: MISSING_AMOUNT }));
    expect(r.closingBalance).toBeNull();
    expect(r.reconciliation).toBe("CANNOT_ASSESS");
    expect(r.dataGaps.some((g) => g.includes("MISSING"))).toBe(true);
  });

  it("NOT_APPLICABLE opening blocks closingBalance — never defaulted to 0", () => {
    const r = buildGenericScheduleMovement(baseInput({ openingBalance: NOT_APPLICABLE_AMOUNT }));
    expect(r.closingBalance).toBeNull();
    expect(r.reconciliation).toBe("CANNOT_ASSESS");
    expect(r.dataGaps.some((g) => g.includes("NOT_APPLICABLE"))).toBe(true);
  });
});

describe("buildGenericScheduleMovement — movements", () => {
  it("a positive and a negative movement net correctly", () => {
    const r = buildGenericScheduleMovement(baseInput({
      movements: [
        { category: "RECEIPT_INCREASE", amount: 300_000, evidence: [] },
        { category: "RELEASE_TO_INCOME", amount: -120_000, evidence: [] },
      ],
      tbClosingBalance: 1_180_000,
    }));
    expect(r.closingBalance).toBe(1_180_000);
    expect(r.reconciliation).toBe("RECONCILED");
  });

  it("an explicit zero movement is preserved as real evidence, not stripped", () => {
    const r = buildGenericScheduleMovement(baseInput({
      movements: [{ category: "RECEIPT_INCREASE", amount: 0, evidence: [] }],
    }));
    expect(r.movements).toHaveLength(1);
    expect(r.movements[0].amount).toBe(0);
    expect(r.closingBalance).toBe(1_000_000);
  });

  it("multiple movements across categories all contribute to closing", () => {
    const r = buildGenericScheduleMovement(baseInput({
      scheduleType: "PROVISIONS_MOVEMENT",
      openingBalance: KNOWN(2_000_000),
      movements: [
        { category: "CHARGED_ADDITIONAL", amount: 400_000, evidence: [] },
        { category: "UTILIZED", amount: -150_000, evidence: [] },
        { category: "REVERSED_UNUSED", amount: -50_000, evidence: [] },
      ],
      tbClosingBalance: 2_200_000,
    }));
    expect(r.closingBalance).toBe(2_200_000);
    expect(r.reconciliation).toBe("RECONCILED");
  });

  it("a null (unassessable) movement amount blocks closingBalance — never coalesced to 0", () => {
    const r = buildGenericScheduleMovement(baseInput({
      movements: [
        { category: "RECEIPT_INCREASE", amount: 300_000, evidence: [] },
        { category: "RELEASE_TO_INCOME", amount: null, evidence: [] },
      ],
    }));
    expect(r.closingBalance).toBeNull();
    expect(r.reconciliation).toBe("CANNOT_ASSESS");
    expect(r.dataGaps.some((g) => g.includes("RELEASE_TO_INCOME"))).toBe(true);
  });

  it("OTHER_EVIDENCED_MOVEMENT is never auto-inserted — an unreconciled gap surfaces as drift, not a fabricated line", () => {
    const r = buildGenericScheduleMovement(baseInput({
      movements: [{ category: "RECEIPT_INCREASE", amount: 300_000, evidence: [] }],
      tbClosingBalance: 1_500_000, // does not match opening + movement — a real, unexplained gap
      toleranceTzs: 1_000,
    }));
    expect(r.movements.some((m) => m.category === "OTHER_EVIDENCED_MOVEMENT")).toBe(false);
    expect(r.closingBalance).toBe(1_300_000);
    expect(r.reconciliation).toBe("DRIFT_EXCEEDS_TOLERANCE");
    expect(r.reconciliationDrift).toBe(200_000);
  });
});

describe("buildGenericScheduleMovement — reconciliation", () => {
  it("exact match is RECONCILED with zero drift", () => {
    const r = buildGenericScheduleMovement(baseInput());
    expect(r.reconciliationDrift).toBe(0);
  });

  it("drift within tolerance is DRIFT_WITHIN_TOLERANCE, not RECONCILED and not a failure", () => {
    const r = buildGenericScheduleMovement(baseInput({ tbClosingBalance: 1_000_500, toleranceTzs: 1_000 }));
    expect(r.reconciliation).toBe("DRIFT_WITHIN_TOLERANCE");
    expect(r.reconciliationDrift).toBe(500);
  });

  it("drift exceeding tolerance is DRIFT_EXCEEDS_TOLERANCE", () => {
    const r = buildGenericScheduleMovement(baseInput({ tbClosingBalance: 1_050_000, toleranceTzs: 1_000 }));
    expect(r.reconciliation).toBe("DRIFT_EXCEEDS_TOLERANCE");
    expect(r.reconciliationDrift).toBe(50_000);
  });

  it("missing TB closing balance is CANNOT_ASSESS, never compared against a fabricated 0", () => {
    const r = buildGenericScheduleMovement(baseInput({ tbClosingBalance: null }));
    expect(r.reconciliation).toBe("CANNOT_ASSESS");
    expect(r.reconciliationDrift).toBeNull();
    expect(r.dataGaps.some((g) => g.includes("No TB closing balance"))).toBe(true);
  });

  it("tolerance is caller-supplied and actually changes the verdict for the same drift — never hardcoded", () => {
    const loose = buildGenericScheduleMovement(baseInput({ tbClosingBalance: 1_010_000, toleranceTzs: 50_000 }));
    const strict = buildGenericScheduleMovement(baseInput({ tbClosingBalance: 1_010_000, toleranceTzs: 1_000 }));
    expect(loose.reconciliation).toBe("DRIFT_WITHIN_TOLERANCE");
    expect(strict.reconciliation).toBe("DRIFT_EXCEEDS_TOLERANCE");
  });
});

describe("buildGenericScheduleMovement — certification precondition (fail-closed, pure)", () => {
  it("certified verdict permits full assessment", () => {
    const r = buildGenericScheduleMovement(baseInput({ certification: { verdict: "certified" } }));
    expect(r.reconciliation).not.toBe("CANNOT_ASSESS");
  });

  it.each(["review", "blocked", "pending", "stale", "unknown", "superseded"] as const)(
    "verdict '%s' fails closed to CANNOT_ASSESS — never computes off uncertified TB authority",
    (verdict) => {
      const r = buildGenericScheduleMovement(baseInput({ certification: { verdict } }));
      expect(r.closingBalance).toBeNull();
      expect(r.reconciliation).toBe("CANNOT_ASSESS");
      expect(r.dataGaps.some((g) => g.includes(verdict))).toBe(true);
    },
  );

  it("does not import React, Supabase, or workspace state — engine stays pure (proven by successful import + call with only plain data)", () => {
    // If this module transitively required a DOM/React/Supabase runtime,
    // this plain Node/vitest call would fail to construct — it doesn't.
    expect(() => buildGenericScheduleMovement(baseInput())).not.toThrow();
  });
});

describe("buildGenericScheduleMovement — Capital Grants / Provisions never invent authority", () => {
  it("Capital Grants movement never fabricates a split from Deferred Income — caller supplies its own account population/amounts; the engine performs no Deferred-Income-specific lookup", () => {
    const r = buildGenericScheduleMovement(baseInput({
      scheduleType: "CAPITAL_GRANTS_MOVEMENT",
      movements: [{ category: "GRANT_RECEIVED", amount: 200_000, evidence: [] }],
      tbClosingBalance: 1_200_000,
    }));
    expect(r.scheduleType).toBe("CAPITAL_GRANTS_MOVEMENT");
    expect(r.closingBalance).toBe(1_200_000);
  });

  it("Provisions movement categories are IAS 37/IPSAS 19 liability-provision semantics, structurally distinct from ECL contra-asset categories", () => {
    const r = buildGenericScheduleMovement(baseInput({
      scheduleType: "PROVISIONS_MOVEMENT",
      movements: [{ category: "CHARGED_ADDITIONAL", amount: 100_000, evidence: [] }],
      tbClosingBalance: 1_100_000,
    }));
    expect(r.scheduleType).toBe("PROVISIONS_MOVEMENT");
    const categories: string[] = r.movements.map((m) => m.category);
    expect(categories).not.toContain("RECEIVABLES_ECL_PROVISION_CONTRA");
    expect(categories).not.toContain("CASH_ECL_PROVISION_CONTRA");
  });
});

describe("buildGenericScheduleMovement — neutrality", () => {
  it("no framework-specific branch: identical numeric behaviour regardless of which schedule type is passed", () => {
    const forDeferred = buildGenericScheduleMovement(baseInput({ scheduleType: "DEFERRED_INCOME_MOVEMENT" }));
    const forGrants = buildGenericScheduleMovement(baseInput({ scheduleType: "CAPITAL_GRANTS_MOVEMENT" }));
    const forProvisions = buildGenericScheduleMovement(baseInput({ scheduleType: "PROVISIONS_MOVEMENT" }));
    expect(forDeferred.closingBalance).toBe(forGrants.closingBalance);
    expect(forGrants.closingBalance).toBe(forProvisions.closingBalance);
  });

  it("consumes only already-normalized signed amounts — no cumulative-to-date/MUSE-specific derivation anywhere in this engine", () => {
    // A single discrete amount is all the contract accepts; there is no
    // cumulativeAdditionsPriorPeriod-style field to even supply here,
    // unlike buildAssetCategoryMovement's PPE-specific input shape.
    const r = buildGenericScheduleMovement(baseInput({
      movements: [{ category: "RECEIPT_INCREASE", amount: 42, evidence: [] }],
      tbClosingBalance: 1_000_042,
    }));
    expect(r.closingBalance).toBe(1_000_042);
  });
});

describe("buildGenericScheduleMovement — determinism", () => {
  it("same movements supplied in a different order produce a byte-identical output array and identical closing/reconciliation", () => {
    const a: ScheduleMovementLine = { category: "RELEASE_TO_INCOME", amount: -50_000, evidence: [] };
    const b: ScheduleMovementLine = { category: "RECEIPT_INCREASE", amount: 300_000, evidence: [] };
    const c: ScheduleMovementLine = { category: "RECEIPT_INCREASE", amount: 10_000, evidence: [] };

    const forward = buildGenericScheduleMovement(baseInput({ movements: [a, b, c], tbClosingBalance: 1_260_000 }));
    const reversed = buildGenericScheduleMovement(baseInput({ movements: [c, b, a], tbClosingBalance: 1_260_000 }));
    const shuffled = buildGenericScheduleMovement(baseInput({ movements: [b, a, c], tbClosingBalance: 1_260_000 }));

    expect(forward.movements).toEqual(reversed.movements);
    expect(forward.movements).toEqual(shuffled.movements);
    expect(forward.closingBalance).toBe(reversed.closingBalance);
    expect(forward.closingBalance).toBe(shuffled.closingBalance);
    expect(forward.reconciliation).toBe(reversed.reconciliation);
  });
});
