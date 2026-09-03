/**
 * evidenceResolverGuards.test.ts — Ω∞ Phase 3 Foundation Contract.
 *
 * Proves the guards use only canonical repository enum literals (never the
 * lowercase "ifrs"/"ifrs_sme"/"lga"/"central_agency" forms that appeared in
 * the pre-Gate design draft), and that balance-side casing normalization
 * behaves correctly. TYPE CONTRACT + PURE FUNCTIONS ONLY — no resolver
 * behavior is exercised here.
 */

import { describe, it, expect } from "vitest";
import { isTaxonomyAvailable, isGFSApplicable, normalizeBalanceSide } from "./evidenceResolverGuards";

describe("isTaxonomyAvailable — canonical ReportingFramework literals only", () => {
  it("IFRS -> IFRS_FULL", () => {
    expect(isTaxonomyAvailable("IFRS")).toBe("IFRS_FULL");
  });

  it("IFRS_FOR_SMES -> IFRS_SME", () => {
    expect(isTaxonomyAvailable("IFRS_FOR_SMES")).toBe("IFRS_SME");
  });

  it("IPSAS_ACCRUAL, OTHER_CONFIRMED, UNKNOWN all -> false (no official taxonomy / unconfirmed)", () => {
    expect(isTaxonomyAvailable("IPSAS_ACCRUAL")).toBe(false);
    expect(isTaxonomyAvailable("OTHER_CONFIRMED")).toBe(false);
    expect(isTaxonomyAvailable("UNKNOWN")).toBe(false);
  });
});

describe("isGFSApplicable — canonical EntityClass literals only", () => {
  it("LOCAL_GOVERNMENT and CENTRAL_GOVERNMENT are applicable", () => {
    expect(isGFSApplicable("LOCAL_GOVERNMENT")).toBe(true);
    expect(isGFSApplicable("CENTRAL_GOVERNMENT")).toBe(true);
  });

  it("every other EntityClass, and null, is not applicable", () => {
    expect(isGFSApplicable("PRIVATE_COMPANY")).toBe(false);
    expect(isGFSApplicable("NONPROFIT_NGO")).toBe(false);
    expect(isGFSApplicable("UNKNOWN")).toBe(false);
    expect(isGFSApplicable(null)).toBe(false);
  });
});

describe("[F] normalizeBalanceSide — casing bridge between Tier 7 and taxonomy convention", () => {
  it("DEBIT -> debit", () => {
    expect(normalizeBalanceSide("DEBIT")).toBe("debit");
  });

  it("CREDIT -> credit", () => {
    expect(normalizeBalanceSide("CREDIT")).toBe("credit");
  });
});

describe("guards contain no classification/mapping/GFS/taxonomy-matching/confidence-aggregation behavior", () => {
  it("the module source has no GFS/taxonomy-matching/confidence-combination logic", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const source: string = fs.readFileSync(
      path.join(__dirname, "evidenceResolverGuards.ts"),
      "utf-8",
    );
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/GFSGroup|GFSClassification|minConfidence|confidenceRank|Math\.min/);
  });
});
