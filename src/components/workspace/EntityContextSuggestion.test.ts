import { describe, it, expect } from "vitest";
import { formatEntityContextSuggestion, FRAMEWORK_NOT_SELECTED } from "./EntityContextSuggestion";

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
  it('says exactly "Framework not selected" for a null value ("Decide later") — never a fabricated or "unconfirmed default" value', () => {
    expect(formatEntityContextSuggestion(null)).toEqual({ text: "Framework not selected", confidence: "NONE", detail: undefined });
    expect(FRAMEWORK_NOT_SELECTED).toBe("Framework not selected");
  });

  it("says the same for undefined and for a value outside the known CHECK constraint", () => {
    expect(formatEntityContextSuggestion(undefined)!.text).toBe("Framework not selected");
    expect(formatEntityContextSuggestion("not_a_real_framework")!.text).toBe("Framework not selected");
  });
});

describe("formatEntityContextSuggestion — an explicit selection at workspace creation is confirmed", () => {
  const AFTER = "2026-09-19T08:00:00Z"; // after the 2026-09-03 cut-over that removed the schema default
  const BEFORE = "2026-08-01T08:00:00Z";

  it("IFRS for SMES selected on a post-cut-over company reads as confirmed, not as an unconfirmed default", () => {
    const r = formatEntityContextSuggestion("ifrs_for_smes", AFTER)!;
    expect(r.text).toBe("Reporting framework: IFRS for SMEs (confirmed)");
    expect(r.confidence).toBe("HIGH");
    expect(r.text).not.toMatch(/unconfirmed/);
  });

  it("every explicit framework on a post-cut-over company is confirmed", () => {
    for (const v of ["full_ifrs", "ifrs_for_smes", "ipsas_accrual", "ipsas_cash"]) expect(formatEntityContextSuggestion(v, AFTER)!.confidence).toBe("HIGH");
  });

  it("a legacy row (created before the cut-over, or of unknown age) keeps the honest 'unconfirmed default' reading", () => {
    expect(formatEntityContextSuggestion("ifrs_for_smes", BEFORE)!.text).toMatch(/unconfirmed default/);
    expect(formatEntityContextSuggestion("ifrs_for_smes", null)!.text).toMatch(/unconfirmed default/);
  });

  it("'Decide later' on a post-cut-over company is still Framework not selected", () => {
    expect(formatEntityContextSuggestion(null, AFTER)!.text).toBe("Framework not selected");
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
