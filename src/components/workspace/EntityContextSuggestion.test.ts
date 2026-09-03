import { describe, it, expect } from "vitest";
import { formatEntityContextSuggestion } from "./EntityContextSuggestion";

// No React component-testing harness exists in this project (no
// @testing-library/react dependency) — per the Slice 4B hardening scope,
// this tests the pure detector/formatting boundary
// (formatEntityContextSuggestion, and the already-tested
// detectEntityAccountingContext it wraps) rather than adding new test
// infrastructure. Component-level rendering (the <p>/null branch,
// data-confidence attribute) is not exercised here — that limitation is
// intentional, not an oversight.

describe("formatEntityContextSuggestion — reporting_framework present", () => {
  it("renders only the reporting-framework signal for an explicit non-default value", () => {
    const result = formatEntityContextSuggestion("ipsas_accrual");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Reporting framework: IPSAS (accrual) (set by preparer)");
    expect(result!.confidence).toBe("MEDIUM");
  });

  it("marks the schema default value as an unconfirmed default, not a detected fact", () => {
    const result = formatEntityContextSuggestion("ifrs_for_smes");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Reporting framework: IFRS for SMEs (unconfirmed default)");
    expect(result!.confidence).toBe("LOW");
  });
});

describe("formatEntityContextSuggestion — reporting_framework absent/invalid", () => {
  it("renders nothing (null) for a null value — never fabricates a signal", () => {
    expect(formatEntityContextSuggestion(null)).toBeNull();
  });

  it("renders nothing (null) for undefined", () => {
    expect(formatEntityContextSuggestion(undefined)).toBeNull();
  });

  it("renders nothing (null) for a value outside the known CHECK constraint", () => {
    expect(formatEntityContextSuggestion("not_a_real_framework")).toBeNull();
  });
});

describe("formatEntityContextSuggestion — inference boundaries", () => {
  it("wording never mentions government/private/NGO/ownership/source-system/jurisdiction", () => {
    const cases = ["ifrs_for_smes", "full_ifrs", "ipsas_accrual", "ipsas_cash"];
    for (const value of cases) {
      const result = formatEntityContextSuggestion(value);
      const text = (result?.text ?? "").toLowerCase();
      expect(text).not.toMatch(/government|private compan|ngo|ownership|muse|tanzania|source system/);
    }
  });

  it("never claims 'detected' or 'suggested' wording not backed by real evidence", () => {
    const result = formatEntityContextSuggestion("ifrs_for_smes");
    expect(result!.text.toLowerCase()).not.toMatch(/detected|suggested/);
  });
});
