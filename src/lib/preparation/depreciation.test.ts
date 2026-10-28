import { describe, expect, it } from "vitest";
import { classCharge, depreciationCharge, revisedStraightLineCharge, type DepreciationItem } from "./depreciation";

// Synthetic inputs (TZS, exponent 2), expected results calculated by hand. Lives and residual values are test inputs,
// never recommendations.
const period = { start: "2026-01-01", end: "2026-12-31" };
const item = (over: Partial<DepreciationItem>): DepreciationItem => ({
  label: "Machine", costMinor: "1000000", residualMinor: "0", openingAccumulatedMinor: "0", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "", ...over,
});

describe("deterministic depreciation (17.16, 17.18-17.23)", () => {
  it("AC-11: components depreciated separately (4,000/5 + 6,000/15 = 1,200) differ from the single-asset 1,000", () => {
    const r = classCharge([item({ label: "Motor", costMinor: "400000", lifeYears: "5" }), item({ label: "Frame", costMinor: "600000", lifeYears: "15" })], period, "full-period");
    expect(r.state).toBe("calculated");
    expect((r as { chargeMinor: string }).chargeMinor).toBe("120000");
    expect(depreciationCharge(item({}), period, "full-period")).toMatchObject({ state: "calculated", chargeMinor: "100000" });
  });
  it("AC-12: a shortened remaining life is applied prospectively: 8,000 / 2 = 4,000, effect +2,000", () => {
    expect(revisedStraightLineCharge("800000", "0", "2", "200000")).toEqual({ state: "calculated", chargeMinor: "400000", effectMinor: "200000" });
    expect(revisedStraightLineCharge("800000", "0", "0", "200000")).toMatchObject({ state: "insufficient" });
  });
  it("AC-13(a): cost 9,000, residual 1,000, 4 years, full year = 2,000", () => {
    expect(depreciationCharge(item({ costMinor: "900000", residualMinor: "100000", lifeYears: "4" }), period, "full-period")).toMatchObject({ chargeMinor: "200000", capped: false });
  });
  it("AC-13(b): a residual value above the carrying amount gives a charge of 0, never negative", () => {
    expect(depreciationCharge(item({ costMinor: "900000", residualMinor: "950000", lifeYears: "4" }), period, "full-period")).toMatchObject({ chargeMinor: "0" });
  });
  it("AC-13(c): units of production: 8,000 x 12,000 / 100,000 = 960", () => {
    expect(depreciationCharge(item({ costMinor: "800000", residualMinor: "0", method: "units-of-production", totalUnits: "100000", unitsThisPeriod: "12000" }), period, "daily")).toMatchObject({ chargeMinor: "96000" });
  });
  it("AC-13(d): available for use on day 274 of a 365-day year under the daily convention: 2,000 x 92/365 = 504.11", () => {
    const r = depreciationCharge(item({ costMinor: "900000", residualMinor: "100000", lifeYears: "4", availableFrom: "2026-10-01" }), period, "daily");
    expect(r).toMatchObject({ chargeMinor: "50411", daysAvailable: 92, daysInPeriod: 365 });
    expect((r as { basis: string }).basis).toContain("92/365");
    // The same addition under the full-period convention is charged for the whole period: the convention is the entity's recorded policy.
    expect(depreciationCharge(item({ costMinor: "900000", residualMinor: "100000", lifeYears: "4", availableFrom: "2026-10-01" }), period, "full-period")).toMatchObject({ chargeMinor: "200000" });
  });
  it("ceases on derecognition (17.20): disposed on 1 April, charged for 90 days", () => {
    expect(depreciationCharge(item({ costMinor: "365000", lifeYears: "1", derecognisedOn: "2026-04-01" }), period, "daily")).toMatchObject({ chargeMinor: "90000", daysAvailable: 90 });
  });
  it("reducing balance: 25% of the carrying amount, rounded half-up to the minor unit", () => {
    expect(depreciationCharge(item({ costMinor: "1000000", openingAccumulatedMinor: "250000", method: "reducing-balance", ratePercent: "25" }), period, "full-period")).toMatchObject({ chargeMinor: "187500" });
    expect(depreciationCharge(item({ costMinor: "100001", method: "reducing-balance", ratePercent: "33.333" }), period, "full-period")).toMatchObject({ chargeMinor: "33333" });
  });
  it("caps the charge at the remaining depreciable amount in the final period", () => {
    expect(depreciationCharge(item({ costMinor: "1000000", residualMinor: "100000", openingAccumulatedMinor: "850000", lifeYears: "10" }), period, "full-period")).toMatchObject({ chargeMinor: "50000", capped: true });
  });
  it("refuses to calculate while an input is missing and never substitutes a life, rate, residual value or convention", () => {
    expect(depreciationCharge(item({ lifeYears: "" }), period, "full-period")).toEqual({ state: "insufficient", missing: ["useful life in years"] });
    expect(depreciationCharge(item({ residualMinor: "" }), period, "full-period")).toMatchObject({ state: "insufficient", missing: expect.arrayContaining([expect.stringContaining("residual value")]) });
    expect(depreciationCharge(item({}), period, "")).toMatchObject({ missing: ["part-period convention (the entity's policy)"] });
    expect(depreciationCharge(item({ method: "" }), period, "daily")).toMatchObject({ missing: ["depreciation method"] });
    expect(depreciationCharge(item({ availableFrom: "2026-02-30" }), period, "daily")).toMatchObject({ missing: ["available-for-use date"] });
    expect(classCharge([], period, "daily").state).toBe("insufficient");
  });
});
