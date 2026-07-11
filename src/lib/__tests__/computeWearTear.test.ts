/**
 * computeWearTear.test.ts
 * Phase 2 — Golden fixture tests for ITA Chapter 332 s.34 W&T calculator
 *
 * All expected values manually verified against ITA Cap.332 R.E.2023 s.34.
 * These are the ground-truth fixtures. If any of these fail after a code change,
 * the code is wrong — do not change the expected values.
 *
 * ITA s.34 Classes:
 *   1 → 37.5% RB   (computers, tech)
 *   2 → 25%   RB   (vehicles, furniture)
 *   3 → 12.5% RB   (heavy equipment)
 *   5 → 20%   SL   (production buildings)
 *   6 → 5%    SL   (commercial buildings)
 *   7 → null       (intangibles — useful life unknown)
 *   8 → 100%  immediate (R&D)
 */

import { describe, it, expect } from "vitest";
import { computeWearTear, ITA_CLASS_CONFIG, getITAClassConfig } from "../computeWearTear";

// ── Class 1 — 37.5% Reducing Balance ─────────────────────────────────────────

describe("Class 1 — 37.5% RB (computers)", () => {
  it("basic: no additions or disposals", () => {
    const result = computeWearTear({
      itaClass: 1,
      openingWDV: 1_000_000,
      additions: 0,
      disposals: 0,
      cost: 1_000_000,
    });
    expect(result.wearTear).toBe(375_000);       // 1,000,000 × 37.5%
    expect(result.closingWDV).toBe(625_000);     // 1,000,000 − 375,000
  });

  it("with additions increases pool before applying rate", () => {
    const result = computeWearTear({
      itaClass: 1,
      openingWDV: 800_000,
      additions: 200_000,
      disposals: 0,
      cost: 1_000_000,
    });
    expect(result.wearTear).toBe(375_000);       // (800k+200k) × 37.5%
    expect(result.closingWDV).toBe(625_000);
  });

  it("with disposals reduces pool before applying rate", () => {
    const result = computeWearTear({
      itaClass: 1,
      openingWDV: 1_000_000,
      additions: 0,
      disposals: 200_000,
      cost: 1_000_000,
    });
    expect(result.wearTear).toBe(300_000);       // (1,000,000 − 200,000) × 37.5%
    expect(result.closingWDV).toBe(500_000);     // 800,000 − 300,000
  });

  it("closing WDV floors at 0 (disposal wipes asset)", () => {
    const result = computeWearTear({
      itaClass: 1,
      openingWDV: 100_000,
      additions: 0,
      disposals: 200_000,   // disposal exceeds pool
      cost: 100_000,
    });
    expect(result.wearTear).toBe(0);
    expect(result.closingWDV).toBe(0);
  });
});

// ── Class 2 — 25% Reducing Balance ───────────────────────────────────────────

describe("Class 2 — 25% RB (vehicles, furniture)", () => {
  it("basic: vehicle with opening WDV", () => {
    const result = computeWearTear({
      itaClass: 2,
      openingWDV: 40_000_000,
      additions: 0,
      disposals: 0,
      cost: 60_000_000,
    });
    expect(result.wearTear).toBe(10_000_000);    // 40,000,000 × 25%
    expect(result.closingWDV).toBe(30_000_000);
  });

  it("new vehicle purchased in period: additions added to pool", () => {
    const result = computeWearTear({
      itaClass: 2,
      openingWDV: 0,
      additions: 60_000_000,
      disposals: 0,
      cost: 60_000_000,
    });
    expect(result.wearTear).toBe(15_000_000);    // 60,000,000 × 25%
    expect(result.closingWDV).toBe(45_000_000);
  });
});

// ── Class 3 — 12.5% Reducing Balance ─────────────────────────────────────────

describe("Class 3 — 12.5% RB (heavy equipment)", () => {
  it("basic: heavy machinery", () => {
    const result = computeWearTear({
      itaClass: 3,
      openingWDV: 200_000_000,
      additions: 0,
      disposals: 0,
      cost: 200_000_000,
    });
    expect(result.wearTear).toBe(25_000_000);    // 200,000,000 × 12.5%
    expect(result.closingWDV).toBe(175_000_000);
  });
});

// ── Class 5 — 20% Straight Line ──────────────────────────────────────────────

describe("Class 5 — 20% SL (production buildings)", () => {
  it("SL: rate applied to COST, not WDV", () => {
    const result = computeWearTear({
      itaClass: 5,
      openingWDV: 600_000_000,   // WDV varies but rate is on cost
      additions: 0,
      disposals: 0,
      cost: 1_000_000_000,
    });
    expect(result.wearTear).toBe(200_000_000);   // cost × 20% — NOT WDV × 20%
    expect(result.closingWDV).toBe(400_000_000); // 600m − 200m
  });

  it("SL: W&T is same every year (year 1 vs year 3)", () => {
    const yr1 = computeWearTear({ itaClass: 5, openingWDV: 1_000_000_000, additions: 0, disposals: 0, cost: 1_000_000_000 });
    const yr3 = computeWearTear({ itaClass: 5, openingWDV: 600_000_000,  additions: 0, disposals: 0, cost: 1_000_000_000 });
    expect(yr1.wearTear).toBe(yr3.wearTear);     // same annual deduction
    expect(yr1.wearTear).toBe(200_000_000);
  });
});

// ── Class 6 — 5% Straight Line ───────────────────────────────────────────────

describe("Class 6 — 5% SL (commercial buildings)", () => {
  it("basic: commercial building TZS 500M cost", () => {
    const result = computeWearTear({
      itaClass: 6,
      openingWDV: 450_000_000,
      additions: 0,
      disposals: 0,
      cost: 500_000_000,
    });
    expect(result.wearTear).toBe(25_000_000);    // 500M × 5%
    expect(result.closingWDV).toBe(425_000_000); // 450M − 25M
  });

  it("full 20-year lifecycle: cost fully claimed after 20 years", () => {
    // After 20 years of 5% SL, total claimed = 100% of cost
    let wdv = 1_000_000_000;
    let totalWT = 0;
    for (let y = 0; y < 20; y++) {
      const r = computeWearTear({ itaClass: 6, openingWDV: wdv, additions: 0, disposals: 0, cost: 1_000_000_000 });
      totalWT += r.wearTear!;
      wdv = r.closingWDV!;
    }
    expect(totalWT).toBe(1_000_000_000);
    expect(wdv).toBe(0);
  });
});

// ── Class 7 — Useful life SL (intangibles) ───────────────────────────────────

describe("Class 7 — Useful life SL (intangibles)", () => {
  it("returns null for wearTear — engine required", () => {
    const result = computeWearTear({
      itaClass: 7,
      openingWDV: 50_000_000,
      additions: 0,
      disposals: 0,
      cost: 100_000_000,
    });
    expect(result.wearTear).toBeNull();
    expect(result.closingWDV).toBeNull();
    expect(result.nullReason).toBeTruthy();
    expect(result.nullReason).toContain("useful life");
  });

  it("returns null even if useful life could be inferred", () => {
    // No matter what inputs — Class 7 always returns null
    const result = computeWearTear({
      itaClass: 7,
      openingWDV: 0,
      additions: 10_000_000,
      disposals: 0,
      cost: 10_000_000,
    });
    expect(result.wearTear).toBeNull();
  });
});

// ── Class 8 — 100% Immediate (R&D expenditure) ───────────────────────────────

describe("Class 8 — 100% immediate (R&D, agricultural plant)", () => {
  it("100% of additions written off in year of acquisition", () => {
    const result = computeWearTear({
      itaClass: 8,
      openingWDV: 0,
      additions: 300_000_000,
      disposals: 0,
      cost: 300_000_000,
    });
    expect(result.wearTear).toBe(300_000_000);   // 100% of additions
    expect(result.closingWDV).toBe(0);
  });

  it("no new additions = zero W&T (asset already fully expensed)", () => {
    const result = computeWearTear({
      itaClass: 8,
      openingWDV: 0,     // WDV is 0 because prior year wrote it all off
      additions: 0,
      disposals: 0,
      cost: 300_000_000,
    });
    expect(result.wearTear).toBe(0);
    expect(result.closingWDV).toBe(0);
  });
});

// ── Invalid class ──────────────────────────────────────────────────────────────

describe("Invalid ITA class", () => {
  it("throws for class 4 (not recognised under ITA post-2016)", () => {
    expect(() => computeWearTear({
      itaClass: 4 as any,
      openingWDV: 100_000,
      additions: 0,
      disposals: 0,
      cost: 100_000,
    })).toThrow("Unknown ITA class: 4");
  });

  it("throws for class 9 (non-existent)", () => {
    expect(() => computeWearTear({
      itaClass: 9 as any,
      openingWDV: 0,
      additions: 0,
      disposals: 0,
      cost: 0,
    })).toThrow();
  });
});

// ── ITA_CLASS_CONFIG completeness ──────────────────────────────────────────────

describe("ITA_CLASS_CONFIG", () => {
  it("contains exactly 7 entries (classes 1,2,3,5,6,7,8 — no class 4)", () => {
    expect(ITA_CLASS_CONFIG).toHaveLength(7);
    const classes = ITA_CLASS_CONFIG.map(c => c.itaClass);
    expect(classes).toContain(1);
    expect(classes).toContain(2);
    expect(classes).toContain(3);
    expect(classes).not.toContain(4);   // Class 4 abolished Finance Act 2016
    expect(classes).toContain(5);
    expect(classes).toContain(6);
    expect(classes).toContain(7);
    expect(classes).toContain(8);
  });

  it("Class 7 has rateNum=null — signals engine required", () => {
    const cls7 = getITAClassConfig(7)!;
    expect(cls7.rateNum).toBeNull();
  });

  it("RB class rates: Class 1 > Class 2 > Class 3", () => {
    const c1 = getITAClassConfig(1)!;
    const c2 = getITAClassConfig(2)!;
    const c3 = getITAClassConfig(3)!;
    expect(c1.rateNum!).toBeGreaterThan(c2.rateNum!);
    expect(c2.rateNum!).toBeGreaterThan(c3.rateNum!);
    expect(c1.rateNum).toBe(0.375);
    expect(c2.rateNum).toBe(0.25);
    expect(c3.rateNum).toBe(0.125);
  });
});
