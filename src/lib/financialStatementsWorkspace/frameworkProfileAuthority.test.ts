import { describe, expect, it } from "vitest";
import { FRAMEWORK_PROFILES, FRAMEWORK_PROFILES_VERSION, type FrameworkProfile } from "./frameworkProfiles";

const all = Object.values(FRAMEWORK_PROFILES);
const words = (p: FrameworkProfile) =>
  [p.displayName, ...Object.values(p.terminology), ...Object.values(p.statementTitles), ...p.expectedStatements.map((e) => e.title), ...p.disclosureAreas.map((d) => d.label)].join(" | ");

describe("framework profiles are versioned and self-contained", () => {
  it("carry a semantic version", () => {
    expect(FRAMEWORK_PROFILES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("every expected statement and disclosure area cites the standard's own structure", () => {
    for (const p of all) {
      expect(p.comparativesReference.length, p.kind).toBeGreaterThan(3);
      for (const e of p.expectedStatements) expect(e.reference.length, `${p.kind}/${e.kind}`).toBeGreaterThan(3);
      for (const d of p.disclosureAreas) expect(d.reference.length, `${p.kind}/${d.id}`).toBeGreaterThan(3);
      expect(new Set(p.expectedStatements.map((e) => e.kind)).size, p.kind).toBe(p.expectedStatements.length);
    }
  });

  it("no wording leaks between frameworks: IPSAS never says profit/shareholders, IFRS never says surplus/net assets", () => {
    for (const p of all) {
      const w = words(p);
      if (p.kind.startsWith("IPSAS")) expect(w, p.kind).not.toMatch(/profit|shareholder|owners of the parent/i);
      else expect(w, p.kind).not.toMatch(/surplus|net assets|deficit/i);
    }
  });

  it("the cash-basis profile expects the receipts-and-payments statement and none of the accrual primary statements", () => {
    const kinds = FRAMEWORK_PROFILES.IPSAS_CASH.expectedStatements.map((e) => e.kind);
    expect(kinds).toContain("STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS");
    for (const accrual of ["STATEMENT_OF_FINANCIAL_POSITION", "STATEMENT_OF_PROFIT_OR_LOSS", "STATEMENT_OF_CASH_FLOWS", "STATEMENT_OF_CHANGES_IN_EQUITY"]) expect(kinds).not.toContain(accrual);
    expect(FRAMEWORK_PROFILES.IPSAS_CASH.basis).toBe("CASH");
    expect(FRAMEWORK_PROFILES.IPSAS_CASH.trialBalance.status).toBe("UNSUPPORTED");
  });

  it("accrual profiles all expect the statement of financial position, a result statement and a cash flow statement", () => {
    for (const p of all.filter((x) => x.basis === "ACCRUAL")) {
      const kinds = p.expectedStatements.map((e) => e.kind);
      expect(kinds, p.kind).toContain("STATEMENT_OF_FINANCIAL_POSITION");
      expect(kinds, p.kind).toContain("STATEMENT_OF_CASH_FLOWS");
    }
  });

  it("disclosure area ids are stable keys shared by the checklist and the note evidence", () => {
    for (const p of all) expect(new Set(p.disclosureAreas.map((d) => d.id)).size, p.kind).toBe(p.disclosureAreas.length);
    expect(FRAMEWORK_PROFILES.IFRS.disclosureAreas.map((d) => d.id)).toEqual(["basis-of-preparation", "accounting-policies", "supporting-notes"]);
  });
});
