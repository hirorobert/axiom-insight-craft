import { describe, expect, it } from "vitest";
import { resolvePeriodHandoff, type SavedPeriodRow } from "./periodHandoff";
const current: SavedPeriodRow = { id: "c", reporting_start: "2025-01-01", reporting_end: "2025-12-31", reporting_currency: "TZS", prior_period_id: "p" };
const prior: SavedPeriodRow = { id: "p", reporting_start: "2024-01-01", reporting_end: "2024-12-31", reporting_currency: "TZS", prior_period_id: null };
describe("saved period handoff", () => {
  it("uses the recorded link in both directions; does not use array order", () => {
    expect(resolvePeriodHandoff([current, prior], 2025)?.prior?.year).toBe(2024);
    expect(resolvePeriodHandoff([prior, current], 2024)?.following?.year).toBe(2025);
  });
  it("never guesses a prior year from adjacent dates without a recorded link", () => {
    expect(resolvePeriodHandoff([{ ...current, prior_period_id: null }, prior], 2025)?.prior).toBeNull();
  });
  it("does not assume calendar years or the current year's currency for the prior year", () => {
    const c = { ...current, reporting_start: "2025-07-01", reporting_end: "2026-06-30" };
    const p = { ...prior, reporting_start: "2024-07-01", reporting_end: "2025-06-30", reporting_currency: "USD" };
    expect(resolvePeriodHandoff([p, c], 2026)).toMatchObject({ current: { year: 2026 }, prior: { year: 2025, currency: "USD" } });
  });
  it.each([
    [current], [current, { ...prior, reporting_end: "2024-12-30" }],
    [current, { ...prior, reporting_start: "2024-02-30" }],
    [current, { ...prior, reporting_currency: null }], [current, current, prior],
  ])("refuses unreadable, malformed, non-adjacent or ambiguous saved periods (%#)", (...rows) => {
    expect(() => resolvePeriodHandoff(rows as SavedPeriodRow[], 2025)).toThrow();
  });
  it("returns no destination for a year the server did not list", () => expect(resolvePeriodHandoff([current, prior], 2027)).toBeNull());
});
