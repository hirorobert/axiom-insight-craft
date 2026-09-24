/**
 * The pricing catalogue is ONE source, mirrored exactly by 20260925100000 (plans, capacities, offers). Prices never
 * decide authorization, no public $49 tier exists, Enterprise is contact-sales, and no component carries a price of
 * its own.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTRY_PAID_PLAN,
  PRICING_CATALOGUE,
  annualSavingMinor,
  displayCataloguePlanName,
  formatCatalogueAmount,
  planByCode,
} from "./pricingCatalogue";

const ROOT = path.join(__dirname, "../../..");
const MIGRATION = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260925100000_global_capabilities_entitlements_pricing.sql"), "utf8");

describe("the catalogue", () => {
  it("is exactly Free, Practice, Firm and Enterprise, in that order", () => {
    expect(PRICING_CATALOGUE.map((p) => p.code)).toEqual(["FREE", "PRACTICE", "FIRM", "ENTERPRISE"]);
  });
  it("Free $0 · 1 entity · 1 user · no paid capability", () => {
    const p = planByCode("FREE")!;
    expect([p.monthlyMinor, p.annualMinor, p.entityCapacity, p.userCapacity]).toEqual([null, null, 1, 1]);
    expect(p.capabilities).not.toContain("STATEMENT_CERTIFICATION");
    expect(p.capabilities).not.toContain("REPORTING_PACK_EXPORT");
    expect(p.capabilities).not.toContain("CLOSE_INSIGHTS");
    expect(p.capabilities).toContain("COMPARATIVE_REPORTING");
  });
  it("Practice $99 / $990 · 5 entities · 3 users; Firm $299 / $2,990 · 25 entities · 10 users; both with every paid capability", () => {
    const pr = planByCode("PRACTICE")!;
    const fi = planByCode("FIRM")!;
    expect([pr.monthlyMinor, pr.annualMinor, pr.entityCapacity, pr.userCapacity]).toEqual([9900, 99000, 5, 3]);
    expect([fi.monthlyMinor, fi.annualMinor, fi.entityCapacity, fi.userCapacity]).toEqual([29900, 299000, 25, 10]);
    for (const p of [pr, fi]) for (const c of ["STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS", "COMPARATIVE_REPORTING"]) expect(p.capabilities).toContain(c);
  });
  it("Enterprise is contact-sales: no price, contract capacity", () => {
    const p = planByCode("ENTERPRISE")!;
    expect([p.salesMode, p.monthlyMinor, p.annualMinor, p.entityCapacity]).toEqual(["contact_sales", null, null, null]);
  });
  it("comparative reporting is in every plan (never a premium wall)", () => {
    for (const p of PRICING_CATALOGUE) expect(p.capabilities).toContain("COMPARATIVE_REPORTING");
  });
  it("no public $49 / $499 plan exists; the entry paid plan is Practice", () => {
    for (const p of PRICING_CATALOGUE) {
      expect(p.monthlyMinor).not.toBe(4900);
      expect(p.annualMinor).not.toBe(49900);
    }
    expect(ENTRY_PAID_PLAN).toBe("PRACTICE");
  });
  it("annual saving is derived once here: $198 on Practice, $598 on Firm", () => {
    expect(formatCatalogueAmount(annualSavingMinor(planByCode("PRACTICE")!)!)).toBe("$198");
    expect(formatCatalogueAmount(annualSavingMinor(planByCode("FIRM")!)!)).toBe("$598");
    expect(annualSavingMinor(planByCode("ENTERPRISE")!)).toBeNull();
  });
  it("formats whole dollars and names the grandfathered legacy plan honestly", () => {
    expect(formatCatalogueAmount(299000)).toBe("$2,990");
    expect(displayCataloguePlanName("PAID")).toBe("Professional (legacy)");
    expect(displayCataloguePlanName("GOLD")).toBeNull();
  });
});

describe("the catalogue mirrors the migration exactly", () => {
  it("plan capacities and sales modes", () => {
    const block = /CROSS JOIN \(VALUES ([\s\S]*?)\) AS v\(code, name, entities, users, ord, mode\)/.exec(MIGRATION)?.[1] ?? "";
    const rows = [...block.matchAll(/\('([A-Z]+)',\s*'([^']+)',\s*(\w+),\s*(\w+),\s*(\d+),\s*'([a-z_]+)'\)/g)]
      .map((m) => [m[1], m[2], m[3] === "NULL" ? null : Number(m[3]), m[4] === "NULL" ? null : Number(m[4]), m[6]]);
    const expected = PRICING_CATALOGUE.filter((p) => p.code !== "FREE").map((p) => [p.code, p.name, p.entityCapacity, p.userCapacity, p.salesMode]);
    expect(rows).toEqual(expected);
    expect(MIGRATION).toMatch(/SET entity_capacity = 1, user_capacity = 1, is_public = true, display_order = 1, sales_mode = 'free'/);
  });
  it("offer amounts (USD minor units, GLOBAL, non-purchasable) for every self-serve plan and interval", () => {
    const rows = [...MIGRATION.matchAll(/\('(PRACTICE|FIRM)',\s*'CFOCLOSE_\w+',\s*(\d+)::bigint,\s*'(MONTHLY|ANNUAL)'\)/g)].map((m) => `${m[1]}:${m[3]}:${m[2]}`).sort();
    const expected = PRICING_CATALOGUE.flatMap((p) => (p.monthlyMinor === null ? [] : [`${p.code}:MONTHLY:${p.monthlyMinor}`, `${p.code}:ANNUAL:${p.annualMinor}`])).sort();
    expect(rows).toEqual(expected);
    expect(MIGRATION).toMatch(/SELECT v\.offer_code, cp\.id, 'GLOBAL', 'USD', v\.amount, 2, v\.billing_interval, 1/);
    expect(MIGRATION).not.toMatch(/is_purchasable\s*=\s*true/i);
  });
});

describe("prices live in one place and never authorize anything", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
    return out;
  };
  it("no component, page or copy file writes a catalogue price literal of its own", () => {
    const offenders = walk(path.join(ROOT, "src"))
      .filter((f) => !f.endsWith(path.join("commercial", "pricingCatalogue.ts")))
      .filter((f) => /\$(99|990|299|2,990|49|499)\b|\b(9900|99000|29900|299000)\b/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
  it("no authorization path reads a price: the resolver and the walls never mention amounts or offers", () => {
    const authority = MIGRATION.slice(MIGRATION.indexOf("── 5. The entitlement resolver"), MIGRATION.indexOf("── 11. Admin overrides"));
    expect(authority).not.toMatch(/amount_minor|commercial_offers|price/i);
  });
});
