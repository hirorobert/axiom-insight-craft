import { describe, expect, it } from "vitest";
import { EMPTY_PERIOD, derivePeriod, periodName, periodProblem, periodRange, periodYear, type PeriodChoice } from "./reportingPeriod";

const year = (end: string): PeriodChoice => ({ preset: "year", end, start: null });

describe("Phase 2 §5.5 b: presets with defined date arithmetic", () => {
  it("acceptance 6 — a June year end: 'Year ended 30 June 2026', stored 1 Jul 2025 – 30 Jun 2026", () => {
    expect(derivePeriod(year("2026-06-30"))).toEqual({ start: "2025-07-01", end: "2026-06-30" });
    expect(periodName(year("2026-06-30"))).toBe("Year ended 30 June 2026");
    expect(periodRange(derivePeriod(year("2026-06-30"))!)).toBe("1 Jul 2025 – 30 Jun 2026");
    expect(periodYear(year("2026-06-30"))).toBe(2026);
  });
  it("calendar year, quarter and month ends cover whole months", () => {
    expect(derivePeriod(year("2025-12-31"))).toEqual({ start: "2025-01-01", end: "2025-12-31" });
    expect(derivePeriod({ preset: "quarter", end: "2026-03-31", start: null })).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(derivePeriod({ preset: "month", end: "2026-04-30", start: null })).toEqual({ start: "2026-04-01", end: "2026-04-30" });
    expect(derivePeriod({ preset: "month", end: "2026-02-28", start: null })).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });
  it("February month ends, leap years included", () => {
    expect(derivePeriod(year("2024-02-29"))).toEqual({ start: "2023-03-01", end: "2024-02-29" });
    expect(derivePeriod(year("2025-02-28"))).toEqual({ start: "2024-03-01", end: "2025-02-28" });
  });
  it("an end that is not a month end runs back to the day after the same date", () => {
    expect(derivePeriod(year("2026-06-15"))).toEqual({ start: "2025-06-16", end: "2026-06-15" });
    expect(derivePeriod({ preset: "quarter", end: "2026-05-30", start: null })).toEqual({ start: "2026-03-01", end: "2026-05-30" });
  });
  it("acceptance 7 — a custom 15-month period and a backfilled prior year are both valid", () => {
    const custom: PeriodChoice = { preset: "custom", start: "2024-04-01", end: "2025-06-30" };
    expect(periodProblem(custom)).toBeNull();
    expect(derivePeriod(custom)).toEqual({ start: "2024-04-01", end: "2025-06-30" });
    expect(periodName(custom)).toBe("1 Apr 2024 – 30 Jun 2025");
    expect(periodProblem(year("2019-12-31"))).toBeNull();
  });
});

describe("followingYear: a suggestion after a confirmed year, nothing else", () => {
  it("the year after a June year end, and after a calendar year", async () => {
    const { followingYear } = await import("./reportingPeriod");
    expect(followingYear({ start: "2025-07-01", end: "2026-06-30" })).toEqual({ preset: "year", end: "2027-06-30", start: null });
    expect(followingYear({ start: "2025-01-01", end: "2025-12-31" })).toEqual({ preset: "year", end: "2026-12-31", start: null });
    expect(followingYear({ start: "2023-03-01", end: "2024-02-29" })).toEqual({ preset: "year", end: "2025-02-28", start: null });
  });
  it("a quarter or a 15-month period has no automatic successor", async () => {
    const { followingYear } = await import("./reportingPeriod");
    expect(followingYear({ start: "2026-01-01", end: "2026-03-31" })).toBeNull();
    expect(followingYear({ start: "2024-04-01", end: "2025-06-30" })).toBeNull();
  });
});

describe("no silent defaults; the server's limits mirrored in words", () => {
  it("with no evidence nothing is chosen and the card says what is missing", () => {
    expect(periodProblem(EMPTY_PERIOD)).toBe("Choose the period.");
    expect(periodProblem({ preset: "year", end: null, start: null })).toBe("Enter the date the period ends.");
    expect(periodProblem({ preset: "custom", end: "2026-01-31", start: null })).toBe("Enter the date the period starts.");
    expect(derivePeriod(EMPTY_PERIOD)).toBeNull();
    expect(periodName(EMPTY_PERIOD)).toBeNull();
  });
  it("impossible dates, reversed ranges, over-long periods and out-of-range years are refused", () => {
    expect(periodProblem(year("2026-02-30"))).toBe("Enter the date the period ends.");
    expect(periodProblem({ preset: "custom", start: "2026-07-01", end: "2026-06-30" })).toBe("The period starts after it ends.");
    expect(periodProblem({ preset: "custom", start: "2020-01-01", end: "2023-01-01" })).toMatch(/36 months/);
    expect(periodProblem({ preset: "custom", start: "2020-01-01", end: "2022-12-31" })).toBeNull();
    expect(periodProblem(year("1999-12-31"))).toMatch(/between 2000 and 2100/);
  });
});
