/**
 * Synthetic fixture for the IPSAS PPE preparation (TZS, exponent 2). Entity and every figure are invented; no client
 * data. Expected results are derived by hand in the comments, independently of the production formulas.
 *
 * Period 2025-07-01 .. 2026-06-30 (365 days in the year beginning at the period start), daily convention.
 *
 * Motor vehicles
 *   V1 cost 50,000,000.00 residual 5,000,000.00 life 9y   opening acc 15,000,000.00  full year
 *        (50,000,000 − 5,000,000) ÷ 9 = 5,000,000.00                                  → 500,000,000 minor
 *   V2 cost 30,000,000.00 residual 0 life 10y             opening acc  9,000,000.00  sold, derecognised 2026-04-01
 *        days 2025-07-01..2026-03-31 = 31+31+30+31+30+31+31+28+31 = 274
 *        3,000,000.00 × 274 ÷ 365 = 2,252,054.794…                                    → 225,205,479 minor
 *   V3 cost 20,000,000.00 residual 2,000,000.00 life 6y   new, available 2026-01-01
 *        days 2026-01-01..2026-06-30 = 31+28+31+30+31+30 = 181
 *        3,000,000.00 × 181 ÷ 365 = 1,487,671.232…                                    → 148,767,123 minor
 *   class charge = 500,000,000 + 225,205,479 + 148,767,123                            = 873,972,602
 *   gross  : 8,000,000,000 + 2,000,000,000 − 3,000,000,000                            = 7,000,000,000
 *   acc dep: 2,400,000,000 + 873,972,602 − (900,000,000 + 225,205,479)                = 2,148,767,123
 *            (check by item: V1 2,000,000,000 + V3 148,767,123)
 *   carrying: opening 5,600,000,000; closing 7,000,000,000 − 2,148,767,123           = 4,851,232,877
 *   V2 disposal: carrying 3,000,000,000 − 1,125,205,479 = 1,874,794,521; proceeds 1,500,000,000 → loss 374,794,521
 * Office equipment
 *   E1 cost 12,000,000.00 residual 0 life 5y opening acc 4,800,000.00 full year → 2,400,000.00 → 240,000,000 minor
 *   gross 1,200,000,000; acc 480,000,000 → 720,000,000; carrying opening 720,000,000, closing 480,000,000
 * Totals: opening carrying 6,320,000,000; closing 5,331,232,877; depreciation 1,113,972,602; disposal result −374,794,521
 */
import { emptyAnswer, emptyEstimate } from "../preparation/equipmentModel";
import type { ClassEstimate } from "../preparation/equipmentModel";
import type { DepreciationItem } from "../preparation/depreciation";
import type { PpeClassInput, PpeInput } from "./ppeWorkpaper";

export const PERIOD = { start: "2025-07-01", end: "2026-06-30" } as const;
export const DISPLAY = { currency: "TZS", exponent: 2 } as const;
export const EXPECTED = {
  vehiclesCharge: "873972602", officeCharge: "240000000", depreciation: "1113972602",
  openingCarrying: "6320000000", closingCarrying: "5331232877", vehiclesClosingCarrying: "4851232877",
  v2Loss: "-374794521", v2Charge: "225205479", v3Charge: "148767123",
} as const;

const src = { type: "register" as const, reference: "Fixed asset register FY2026" };
const item = (label: string, cost: string, residual: string, life: string, opening: string, extra: Partial<DepreciationItem> = {}): DepreciationItem => ({
  label, costMinor: cost, residualMinor: residual, openingAccumulatedMinor: opening, method: "straight-line", lifeYears: life, ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "", ...extra,
});
const estimate = (items: DepreciationItem[], over: Partial<ClassEstimate> = {}): ClassEstimate => ({
  ...emptyEstimate(), basis: "cost", chargeSource: "calculated", items, rationale: "Expected service lives from usage logs and maintenance plan", evidence: "Management paper MP-2026-04", ...over,
});

export function vehicles(over: Partial<PpeClassInput> = {}): PpeClassInput {
  return {
    classId: "11111111-1111-4111-8111-111111111111", label: "Motor vehicles", accounts: "1210, 1215", measurementModel: "cost", estimateConfirmed: true,
    opening: { grossMinor: "8000000000", accumulatedDepreciationMinor: "2400000000", accumulatedImpairmentMinor: "0", carryingMinor: "5600000000" },
    closing: { grossMinor: "7000000000", accumulatedDepreciationMinor: "2148767123", accumulatedImpairmentMinor: "0", carryingMinor: "4851232877" },
    movements: [
      { kind: "additions", grossMinor: "2000000000", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", source: src, note: "V3 purchase" },
      { kind: "disposals", grossMinor: "-3000000000", accumulatedDepreciationMinor: "-1125205479", accumulatedImpairmentMinor: "0", source: src, note: "V2 sale" },
      { kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "873972602", accumulatedImpairmentMinor: "0", source: src, note: "Charge for the year" },
    ],
    disposals: [{ reference: "V2-Hilux", date: "2026-04-01", costMinor: "3000000000", accumulatedDepreciationMinor: "1125205479", accumulatedImpairmentMinor: "0", proceedsMinor: "1500000000", source: src }],
    estimate: estimate([
      item("V1", "5000000000", "500000000", "9", "1500000000"),
      item("V2", "3000000000", "0", "10", "900000000", { derecognisedOn: "2026-04-01" }),
      item("V3", "2000000000", "200000000", "6", "0", { availableFrom: "2026-01-01" }),
    ]),
    ...over,
  };
}
export function office(over: Partial<PpeClassInput> = {}): PpeClassInput {
  return {
    classId: "22222222-2222-4222-8222-222222222222", label: "Office equipment", accounts: "1220", measurementModel: "cost", estimateConfirmed: true,
    opening: { grossMinor: "1200000000", accumulatedDepreciationMinor: "480000000", accumulatedImpairmentMinor: "0", carryingMinor: "720000000" },
    closing: { grossMinor: "1200000000", accumulatedDepreciationMinor: "720000000", accumulatedImpairmentMinor: "0", carryingMinor: "480000000" },
    movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "240000000", accumulatedImpairmentMinor: "0", source: src, note: "Charge for the year" }],
    disposals: [],
    estimate: estimate([item("E1", "1200000000", "0", "5", "480000000")]),
    ...over,
  };
}
const none = () => ({ ...emptyAnswer(), status: "none_with_basis" as const, text: "Checked the asset register and board minutes", evidence: "Register and minutes FY2026", flags: { applies: false } });
export function allAnswers() {
  return { heritage_assets: none(), infrastructure_assets: none(), impairment_indicators: none(), held_for_sale: none(), commitments_restrictions: none() };
}
export function baseInput(over: Partial<PpeInput> = {}): PpeInput {
  return {
    period: { ...PERIOD }, classes: [vehicles(), office()], entityAnswers: allAnswers(), convention: "daily",
    tb: { ppeCarryingOpeningMinor: EXPECTED.openingCarrying, ppeCarryingClosingMinor: EXPECTED.closingCarrying, depreciationExpenseMinor: EXPECTED.depreciation },
    depreciationDifference: null, ...over,
  };
}
