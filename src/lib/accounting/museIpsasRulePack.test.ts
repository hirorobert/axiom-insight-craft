/**
 * museIpsasRulePack.test.ts
 *
 * Slice 4 — proves the rule pack's structural integrity and the three real
 * exclusion cases it was specifically built to prove out (see the file
 * header comment in museIpsasRulePack.ts for why each one matters).
 */

import { describe, it, expect } from "vitest";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";

describe("TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 — structural integrity", () => {
  it("covers exactly the 294 distinct natural account codes observed in the real Arusha DC MUSE data", () => {
    expect(TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1).toHaveLength(294);
  });

  it("has no duplicate naturalAccountCode — museClassifier's exact-match lookup depends on this", () => {
    const codes = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((r) => r.naturalAccountCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("every rule carries non-empty evidence and cites the real source", () => {
    for (const rule of TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1) {
      expect(rule.evidenceDetail.length).toBeGreaterThan(0);
      expect(rule.evidenceDetail).toContain("Arusha District Council");
      expect(rule.ruleId).toBe(`TZ-IPSAS-MUSE-${rule.naturalAccountCode}`);
    }
  });

  it("every rule is scoped to TZ/IPSAS_ACCRUAL/MUSE/LOCAL_GOVERNMENT — no cross-jurisdiction leakage", () => {
    for (const rule of TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1) {
      expect(rule.jurisdiction).toBe("TZ");
      expect(rule.framework).toBe("IPSAS_ACCRUAL");
      expect(rule.sourceSystem).toBe("MUSE");
      expect(rule.entityClasses).toEqual(["LOCAL_GOVERNMENT"]);
    }
  });
});

function findRule(code: string) {
  const rule = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === code);
  if (!rule) throw new Error(`Expected rule for ${code} to exist`);
  return rule;
}

describe("real exclusion cases (Section VIII: never map mechanically)", () => {
  it("63181188 'Payable MSD Non Cash' is a LIABILITY despite the '63xxxxxx' prefix meaning net assets elsewhere in this same chart", () => {
    const r = findRule("63181188");
    expect(r.accountNature).toBe("LIABILITY");
    expect(r.presentationCode).toBe("PAYABLES_AND_ACCRUALS");
    // Contrast: another real 63xxxxxx code in the SAME chart IS net assets —
    // proving the exclusion is about this specific account, not a broken prefix rule.
    const equityCousin = findRule("63293101");
    expect(equityCousin.accountNature).toBe("NET_ASSETS");
  });

  it("61461101 'Accumulated Depreciation' is a PPE contra-asset, opposite of its '61xxxxxx' sibling '61112102 Opening'", () => {
    const contra = findRule("61461101");
    const addition = findRule("61112102");
    expect(contra.presentationCode).toBe("PPE_ACCUMULATED_DEPRECIATION_CONTRA");
    expect(addition.presentationCode).toBe("PROPERTY_PLANT_EQUIPMENT_OPENING");
    // Both are ASSET-nature (contra-assets net against assets), but the
    // normal balance expectation must flip for the contra account.
    expect(contra.accountNature).toBe("ASSET");
    expect(addition.accountNature).toBe("ASSET");
    expect(contra.normalBalanceExpectation).toBe("credit");
    expect(addition.normalBalanceExpectation).toBe("debit");
  });

  it("31221108 'Spare Parts' is INVENTORY, not PPE, despite sharing the '31xxxxxx' prefix with genuine PPE additions like 31112102", () => {
    const inventory = findRule("31221108");
    const ppe = findRule("31112102");
    expect(inventory.presentationCode).toBe("INVENTORIES");
    expect(ppe.presentationCode).toBe("PROPERTY_PLANT_EQUIPMENT_ADDITIONS");
  });

  it("unsuffixed own-source revenue codes are NOT asserted exchange/non-exchange when the source data itself doesn't say", () => {
    // 14150101 'Revenue from Land' carries no '- Exchange' suffix, unlike
    // many siblings in the same 14xxxxxx family (e.g. 14220260) that do.
    const ambiguous = findRule("14150101");
    expect(ambiguous.presentationCode).toBe("OWN_SOURCE_REVENUE_EXCHANGE_STATUS_UNCONFIRMED");
    expect(ambiguous.confidence).not.toBe("HIGH");

    const explicit = findRule("14220260");
    expect(explicit.presentationCode).toBe("EXCHANGE_REVENUE_FEES_AND_CHARGES");
    expect(explicit.confidence).toBe("HIGH");
  });
});
