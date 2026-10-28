import { describe, expect, it } from "vitest";
import { addMonths, classCharge, depreciationCharge, revisedStraightLineCharge, wholeMonths, type DepreciationItem } from "./depreciation";

// Synthetic inputs (TZS, exponent 2), expected results calculated by hand. Lives and residual values are test inputs,
// never recommendations. The annual charge of the reference item is 1,200,000 / 10 = 120,000 minor (1,200.00) a year.
const year = { start: "2026-01-01", end: "2026-12-31" };
const item = (over: Partial<DepreciationItem>): DepreciationItem => ({
  label: "Machine", costMinor: "1200000", residualMinor: "0", openingAccumulatedMinor: "0", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "", ...over,
});
const charge = (r: ReturnType<typeof depreciationCharge>) => (r as { chargeMinor: string }).chargeMinor;

describe("time basis: a useful life or rate is annual; the period's share follows the recorded convention, never a twelve-month assumption", () => {
  it("a twelve-month calendar year carries the annual charge under both conventions (365/365; 12/12)", () => {
    expect(depreciationCharge(item({}), year, "daily")).toMatchObject({ chargeMinor: "120000", daysAvailable: 365, daysInYear: 365, fraction: { num: "365", den: "365" } });
    expect(depreciationCharge(item({}), year, "full-period")).toMatchObject({ chargeMinor: "120000", fraction: { num: "12", den: "12" } });
  });
  it("REVIEW FINDING (head 4260548): a six-month period must carry half a year, not the annual charge — daily 181/365 = 59,506.85 → 59,507; full-period 6/12 = 60,000", () => {
    const half = { start: "2026-01-01", end: "2026-06-30" };
    expect(depreciationCharge(item({}), half, "daily")).toMatchObject({ chargeMinor: "59507", daysAvailable: 181, daysInYear: 365 });
    expect(depreciationCharge(item({}), half, "full-period")).toMatchObject({ chargeMinor: "60000", fraction: { num: "6", den: "12" } });
  });
  it("an eighteen-month period carries a year and a half: daily 546/365 → 179,506.85 → 179,507; full-period 18/12 = 180,000", () => {
    const long = { start: "2026-01-01", end: "2027-06-30" };
    expect(depreciationCharge(item({}), long, "daily")).toMatchObject({ chargeMinor: "179507", daysAvailable: 546 });
    expect(depreciationCharge(item({}), long, "full-period")).toMatchObject({ chargeMinor: "180000", fraction: { num: "18", den: "12" } });
  });
  it("a leap year is a whole year under the daily convention (366/366), and a day in it is 1/366 of the annual charge", () => {
    const leap = { start: "2028-01-01", end: "2028-12-31" };
    expect(depreciationCharge(item({}), leap, "daily")).toMatchObject({ chargeMinor: "120000", daysAvailable: 366, daysInYear: 366 });
    expect(depreciationCharge(item({ availableFrom: "2028-12-31" }), leap, "daily")).toMatchObject({ chargeMinor: "328", daysAvailable: 1 }); // 120,000 / 366 = 327.87
  });
  it("a non-calendar year (1 July – 30 June) is a whole year; the year that begins on the period start decides the day count (365, or 366 across 29 February)", () => {
    expect(depreciationCharge(item({}), { start: "2025-07-01", end: "2026-06-30" }, "daily")).toMatchObject({ chargeMinor: "120000", daysAvailable: 365, daysInYear: 365 });
    expect(depreciationCharge(item({}), { start: "2027-07-01", end: "2028-06-30" }, "daily")).toMatchObject({ chargeMinor: "120000", daysAvailable: 366, daysInYear: 366 });
    expect(depreciationCharge(item({}), { start: "2025-07-01", end: "2026-06-30" }, "full-period")).toMatchObject({ chargeMinor: "120000", fraction: { num: "12", den: "12" } });
  });
  it("an addition in a short period: available from 1 April in a January–June period → 91/365 → 29,917.81 → 29,918; full-period charges the whole period's six months", () => {
    const half = { start: "2026-01-01", end: "2026-06-30" };
    expect(depreciationCharge(item({ availableFrom: "2026-04-01" }), half, "daily")).toMatchObject({ chargeMinor: "29918", daysAvailable: 91 });
    expect(depreciationCharge(item({ availableFrom: "2026-04-01" }), half, "full-period")).toMatchObject({ chargeMinor: "60000" });
  });
  it("a disposal in a short period: derecognised on 1 April → 90 days → 29,589.04 → 29,589; derecognised before the period or available after it → 0", () => {
    const half = { start: "2026-01-01", end: "2026-06-30" };
    expect(depreciationCharge(item({ derecognisedOn: "2026-04-01" }), half, "daily")).toMatchObject({ chargeMinor: "29589", daysAvailable: 90 });
    expect(depreciationCharge(item({ derecognisedOn: "2025-12-15" }), half, "daily")).toMatchObject({ chargeMinor: "0", daysAvailable: 0 });
    expect(depreciationCharge(item({ derecognisedOn: "2025-12-15" }), half, "full-period")).toMatchObject({ chargeMinor: "0" });
    expect(depreciationCharge(item({ availableFrom: "2026-08-01" }), half, "full-period")).toMatchObject({ chargeMinor: "0" });
  });
  it("the full-period convention needs a period of whole months; a partial month is refused, not approximated", () => {
    const r = depreciationCharge(item({}), { start: "2026-01-01", end: "2026-06-15" }, "full-period");
    expect(r).toMatchObject({ state: "insufficient", missing: [expect.stringContaining("whole months")] });
    expect(depreciationCharge(item({}), { start: "2026-01-01", end: "2026-06-15" }, "daily")).toMatchObject({ chargeMinor: "54575", daysAvailable: 166 }); // 120,000 × 166/365 = 54,575.34
    // Month arithmetic clamps the day to the month's length (as PostgreSQL does): 31 January + 1 month = 28 February, so
    // 31 January – 27 February is one whole month and 31 January – 28 February is not.
    expect(wholeMonths("2026-01-31", "2026-02-27")).toBe(1);
    expect(wholeMonths("2026-01-31", "2026-02-28")).toBeNull();
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });
  it("a reducing-balance rate is annual too: 25% of 1,000,000 over 181/365 days → 123,972.60 → 123,973", () => {
    expect(depreciationCharge(item({ costMinor: "1000000", method: "reducing-balance", ratePercent: "25" }), { start: "2026-01-01", end: "2026-06-30" }, "daily")).toMatchObject({ chargeMinor: "123973" });
    expect(depreciationCharge(item({ costMinor: "1000000", openingAccumulatedMinor: "250000", method: "reducing-balance", ratePercent: "25" }), year, "full-period")).toMatchObject({ chargeMinor: "187500" });
    expect(depreciationCharge(item({ costMinor: "100001", method: "reducing-balance", ratePercent: "33.333" }), year, "full-period")).toMatchObject({ chargeMinor: "33333" });
  });
});

describe("deterministic depreciation (17.16, 17.18-17.23)", () => {
  it("AC-11: components depreciated separately (4,000/5 + 6,000/15 = 1,200) differ from the single-asset 1,000", () => {
    const r = classCharge([item({ label: "Motor", costMinor: "400000", lifeYears: "5" }), item({ label: "Frame", costMinor: "600000", lifeYears: "15" })], year, "full-period");
    expect(r.state).toBe("calculated");
    expect((r as { chargeMinor: string }).chargeMinor).toBe("120000");
    expect(charge(depreciationCharge(item({ costMinor: "1000000" }), year, "full-period"))).toBe("100000");
  });
  it("AC-12: a shortened remaining life is applied prospectively: 8,000 / 2 = 4,000 a year, effect +2,000", () => {
    expect(revisedStraightLineCharge("800000", "0", "2", "200000")).toEqual({ state: "calculated", chargeMinor: "400000", effectMinor: "200000" });
    expect(revisedStraightLineCharge("800000", "0", "0", "200000")).toMatchObject({ state: "insufficient" });
  });
  it("AC-13(a): cost 9,000, residual 1,000, 4 years, full year = 2,000", () => {
    expect(depreciationCharge(item({ costMinor: "900000", residualMinor: "100000", lifeYears: "4" }), year, "full-period")).toMatchObject({ chargeMinor: "200000", capped: false });
  });
  it("AC-13(b): a residual value above the carrying amount gives a charge of 0, never negative", () => {
    expect(depreciationCharge(item({ costMinor: "900000", residualMinor: "950000", lifeYears: "4" }), year, "full-period")).toMatchObject({ chargeMinor: "0" });
  });
  it("AC-13(c): units of production: 8,000 x 12,000 / 100,000 = 960, with no time fraction even in a short period", () => {
    expect(depreciationCharge(item({ costMinor: "800000", residualMinor: "0", method: "units-of-production", totalUnits: "100000", unitsThisPeriod: "12000" }), year, "daily")).toMatchObject({ chargeMinor: "96000" });
    expect(depreciationCharge(item({ costMinor: "800000", residualMinor: "0", method: "units-of-production", totalUnits: "100000", unitsThisPeriod: "12000" }), { start: "2026-01-01", end: "2026-06-15" }, "full-period")).toMatchObject({ chargeMinor: "96000" });
  });
  it("AC-13(d): available for use on day 274 of a 365-day year under the daily convention: 2,000 x 92/365 = 504.11", () => {
    const r = depreciationCharge(item({ costMinor: "900000", residualMinor: "100000", lifeYears: "4", availableFrom: "2026-10-01" }), year, "daily");
    expect(r).toMatchObject({ chargeMinor: "50411", daysAvailable: 92, daysInYear: 365 });
    expect((r as { basis: string }).basis).toContain("92/365 days");
    expect(depreciationCharge(item({ costMinor: "900000", residualMinor: "100000", lifeYears: "4", availableFrom: "2026-10-01" }), year, "full-period")).toMatchObject({ chargeMinor: "200000" });
  });
  it("ceases on derecognition (17.20): disposed on 1 April, charged for 90 days", () => {
    expect(depreciationCharge(item({ costMinor: "365000", lifeYears: "1", derecognisedOn: "2026-04-01" }), year, "daily")).toMatchObject({ chargeMinor: "90000", daysAvailable: 90 });
  });
  it("caps the charge at the remaining depreciable amount in the final period", () => {
    expect(depreciationCharge(item({ costMinor: "1000000", residualMinor: "100000", openingAccumulatedMinor: "850000", lifeYears: "10" }), year, "full-period")).toMatchObject({ chargeMinor: "50000", capped: true });
  });
  it("refuses to calculate while an input is missing and never substitutes a life, rate, residual value or convention", () => {
    expect(depreciationCharge(item({ lifeYears: "" }), year, "full-period")).toEqual({ state: "insufficient", missing: ["useful life in years"] });
    expect(depreciationCharge(item({ residualMinor: "" }), year, "full-period")).toMatchObject({ state: "insufficient", missing: expect.arrayContaining([expect.stringContaining("residual value")]) });
    expect(depreciationCharge(item({}), year, "")).toMatchObject({ missing: ["part-period convention (the entity's policy)"] });
    expect(depreciationCharge(item({ method: "" }), year, "daily")).toMatchObject({ missing: ["depreciation method"] });
    expect(depreciationCharge(item({ availableFrom: "2026-02-30" }), year, "daily")).toMatchObject({ missing: ["available-for-use date"] });
    expect(depreciationCharge(item({}), { start: "2026-12-31", end: "2026-01-01" }, "daily")).toMatchObject({ missing: ["reporting period dates"] });
    expect(classCharge([], year, "daily").state).toBe("insufficient");
  });
});
