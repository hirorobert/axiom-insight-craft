import { describe, expect, it } from "vitest";
import { filingTerm, isFilingTermKey, JURISDICTION_FILING_TERMS, NEUTRAL_FILING_TERMS, type FilingTermKey } from "./filingTerms";

const FORBIDDEN = /\b(TRA|TIN|EFDMS|TAA|SDL|NSSF|PAYE)\b|Tanzania|ITA Cap|Cap\.\s?\d+/;

describe("filing terminology is configuration-driven", () => {
  it("with no jurisdiction configured every term is neutral and carries no statutory citation", () => {
    for (const key of Object.keys(NEUTRAL_FILING_TERMS) as FilingTermKey[]) {
      const t = filingTerm(null, key);
      expect(`${t.label} ${t.description}`, key).not.toMatch(FORBIDDEN);
      expect(t.reference, key).toBeNull();
      expect(filingTerm(undefined, key)).toEqual(t);
    }
  });

  it("an unknown jurisdiction falls back to the neutral vocabulary rather than guessing", () => {
    expect(filingTerm("ZZ", "paye")).toEqual(NEUTRAL_FILING_TERMS.paye);
  });

  it("a configured jurisdiction supplies its own names and citations, and only for the keys it defines", () => {
    expect(filingTerm("TZ", "paye").reference).toMatch(/s\.81/);
    expect(filingTerm("TZ", "paye").label).toBe("PAYE Remittances");
    for (const key of Object.keys(JURISDICTION_FILING_TERMS.TZ) as FilingTermKey[]) expect(isFilingTermKey(key)).toBe(true);
  });

  it("isFilingTermKey rejects arbitrary finding categories", () => {
    expect(isFilingTermKey("paye")).toBe(true);
    expect(isFilingTermKey("something_else")).toBe(false);
  });
});
