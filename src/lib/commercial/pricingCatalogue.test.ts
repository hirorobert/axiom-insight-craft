/**
 * The pricing catalogue is ONE source, mirrored exactly by 20260925100000 and 20260925130000 (plans, capacities,
 * included seats, base offers and the plan x capability matrix) as changed by 20261110100000 (unlimited team members on
 * Solo, Practice and Firm; no seat sales; the proposed seat price retired). There is no free plan and no trial; prices
 * never decide authorization; Enterprise is contact-sales with agreed team members; no component carries a price.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTRY_PAID_PLAN,
  MATRIX_CAPABILITIES,
  PLAN_FEATURE_MATRIX,
  PRICING_CATALOGUE,
  allowedNamedUsers,
  annualSavingMinor,
  displayCataloguePlanName,
  formatCatalogueAmount,
  planByCode,
  planIncludes,
} from "./pricingCatalogue";

const ROOT = path.join(__dirname, "../../..");
const MIGRATION = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260925100000_global_capabilities_entitlements_pricing.sql"), "utf8");
const CATALOGUE_MIGRATION = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql"), "utf8");
const UNLIMITED_MIGRATION = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261110100000_unlimited_team_members.sql"), "utf8");
/** The plans 20261110100000 gives unlimited team members (and stops selling seats on). */
const UNLIMITED_PLANS = /UPDATE public\.commercial_plans SET members_unlimited = true, additional_seats_purchasable = false\s+WHERE code IN \(([^)]*)\)/
  .exec(UNLIMITED_MIGRATION)?.[1].split(",").map((c) => c.trim().replace(/'/g, "")) ?? [];

describe("the catalogue", () => {
  it("is exactly Solo, Practice, Firm and Enterprise, in that order — no free plan, no trial", () => {
    expect(PRICING_CATALOGUE.map((p) => p.code)).toEqual(["SOLO", "PRACTICE", "FIRM", "ENTERPRISE"]);
    for (const p of PRICING_CATALOGUE) {
      expect(p.salesMode).not.toBe("free");
      if (p.salesMode === "self_serve") expect(p.monthlyMinor).toBeGreaterThan(0);
    }
    const text = PRICING_CATALOGUE.flatMap((p) => [p.name, p.tagline, ...p.highlights]).join(" | ");
    expect(text).not.toMatch(/\bfree\b|\btrial\b/i);
  });
  it("Solo $49 / $490 · 1 active entity · unlimited team members", () => {
    const p = planByCode("SOLO")!;
    expect([p.monthlyMinor, p.annualMinor, p.entityCapacity, p.membersUnlimited]).toEqual([4900, 49000, 1, true]);
  });
  it("Practice $99 / $990 · 5 entities; Firm $299 / $2,990 · 25 entities; both unlimited team members; no seat price anywhere", () => {
    const pr = planByCode("PRACTICE")!;
    const fi = planByCode("FIRM")!;
    expect([pr.monthlyMinor, pr.annualMinor, pr.entityCapacity, pr.membersUnlimited]).toEqual([9900, 99000, 5, true]);
    expect([fi.monthlyMinor, fi.annualMinor, fi.entityCapacity, fi.membersUnlimited]).toEqual([29900, 299000, 25, true]);
    for (const p of PRICING_CATALOGUE) expect(p).not.toHaveProperty("additionalSeat");
  });
  it("Enterprise is contact-sales: no price, contract capacity, team members by agreement", () => {
    const p = planByCode("ENTERPRISE")!;
    expect([p.salesMode, p.monthlyMinor, p.annualMinor, p.entityCapacity, p.includedSeats, p.membersUnlimited]).toEqual(["contact_sales", null, null, null, null, false]);
  });
  it("every self-serve plan says 'Unlimited team members'; nothing mentions a named-user count or an additional-user price", () => {
    for (const p of PRICING_CATALOGUE.filter((x) => x.salesMode === "self_serve")) expect(p.highlights).toContain("Unlimited team members");
    const text = PRICING_CATALOGUE.flatMap((p) => [p.tagline, ...p.highlights]).join(" | ");
    expect(text).not.toMatch(/named user|additional user|per seat|USD 200|\$200/i);
  });
  it("comparative reporting is in every plan (never separately paywalled)", () => {
    for (const p of PRICING_CATALOGUE) expect(p.capabilities).toContain("COMPARATIVE_REPORTING");
    for (const p of PRICING_CATALOGUE) expect(planIncludes(p.code, "COMPARATIVE_REPORTING")).toBe(true);
  });
  it("the entry plan is Solo; the retired Free plan is never a catalogue plan", () => {
    expect(ENTRY_PAID_PLAN).toBe("SOLO");
    expect(planByCode("FREE")).toBeNull();
    expect(displayCataloguePlanName("FREE")).toBe("Free (retired)");
  });
  it("annual saving is derived once here: $98 on Solo, $198 on Practice, $598 on Firm", () => {
    expect(formatCatalogueAmount(annualSavingMinor(planByCode("SOLO")!)!)).toBe("$98");
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

describe("the plan x capability matrix", () => {
  it("covers Close Certification, Reporting Pack, Close Insights, Close Assurance, clean PDF, Excel, filing packs, management letters, multi-entity reporting, consolidation and regional packs", () => {
    expect([...MATRIX_CAPABILITIES]).toEqual([
      "CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS",
      "CLEAN_PDF", "EXCEL_EXPORT", "FILING_PACKS", "MANAGEMENT_LETTERS", "MULTI_ENTITY_REPORTING", "CONSOLIDATION", "REGIONAL_PACKS",
    ]);
  });
  it("multi-entity reporting follows entity capacity (not Solo); consolidation is offered on no plan", () => {
    for (const p of PRICING_CATALOGUE) expect(planIncludes(p.code, "MULTI_ENTITY_REPORTING")).toBe(p.entityCapacity === null || p.entityCapacity > 1);
    for (const p of [...PRICING_CATALOGUE.map((x) => x.code), "PAID"]) expect(planIncludes(p, "CONSOLIDATION")).toBe(false);
  });
  it("unknown plans, unknown capabilities, no plan and the retired Free plan are never included (fail closed)", () => {
    for (const plan of [null, undefined, "", "FREE", "GOLD", "solo"]) expect(planIncludes(plan, "CLOSE_ASSURANCE")).toBe(false);
    for (const cap of ["", "UNKNOWN", "close_assurance", "ENTITY_CAPACITY", "toString", "__proto__"]) expect(planIncludes("FIRM", cap)).toBe(false);
  });
  it("mirrors commercial_plan_features in 20260925130000 exactly (same capabilities, same plans, same order)", () => {
    const block = /CROSS JOIN \(VALUES([\s\S]*?)\) AS m\(capability, plans\)/.exec(CATALOGUE_MIGRATION)?.[1] ?? "";
    const rows = Object.fromEntries([...block.matchAll(/\('([A-Z_]+)',\s*ARRAY\[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/'([A-Z]+)'/g)].map((x) => x[1])]));
    expect(rows).toEqual(Object.fromEntries(MATRIX_CAPABILITIES.map((c) => [c, [...PLAN_FEATURE_MATRIX[c]]])));
  });
});

describe("named users: allowed = included + purchased", () => {
  it("the recorded included seats are kept as the database holds them (history on unlimited plans; Enterprise negotiated)", () => {
    expect(PRICING_CATALOGUE.map((p) => p.includedSeats)).toEqual([1, 1, 1, null]);
  });
  it("Solo, Practice and Firm resolve to an explicit 'unlimited' whatever seats a licence records — never a number", () => {
    for (const code of ["SOLO", "PRACTICE", "FIRM"]) for (const q of [0, 4, 12]) expect(allowedNamedUsers(planByCode(code), q)).toBe("unlimited");
  });
  it("Enterprise needs its negotiated seats; without them, or with malformed quantities, it is undetermined", () => {
    expect(allowedNamedUsers(planByCode("ENTERPRISE"), 0)).toBeNull();
    expect(allowedNamedUsers(planByCode("ENTERPRISE"), 0, 40)).toBe(40);
    expect(allowedNamedUsers(planByCode("ENTERPRISE"), 2, 40)).toBe(42);
    for (const q of [undefined, null, -1, 1.5, "2", Number.NaN, Number.POSITIVE_INFINITY, {}]) expect(allowedNamedUsers(planByCode("ENTERPRISE"), q, 40)).toBeNull();
    expect(allowedNamedUsers(null, 1)).toBeNull();
  });
  it("no plan claims bundled user counts, assignment or review workflows", () => {
    const text = PRICING_CATALOGUE.flatMap((p) => [p.tagline, ...p.highlights]).join(" | ");
    expect(text).not.toMatch(/\b(3|10) users\b|up to \d+ users|assignment|review workflow|reviewer/i);
  });
});

describe("the catalogue mirrors the migrations exactly", () => {
  it("plan capacities, included seats, seat purchasability and sales modes", () => {
    const block = /CROSS JOIN \(VALUES ([\s\S]*?)\) AS v\(code, name, entities, seats, buy_seats, ord, mode\)/.exec(MIGRATION)?.[1] ?? "";
    const rows = [...block.matchAll(/\('([A-Z]+)',\s*'([^']+)',\s*(\w+),\s*(\w+),\s*(true|false),\s*(\d+),\s*'([a-z_]+)'\)/g)]
      .map((m) => [m[1], m[2], m[3] === "NULL" ? null : Number(m[3]), m[4] === "NULL" ? null : Number(m[4]), m[5] === "true", m[7]]);
    const solo = /SELECT p\.id, 'SOLO', '([^']+)',[\s\S]*?\n\s*(\d+), (\d+), (true|false), true, 1, '([a-z_]+)'/.exec(CATALOGUE_MIGRATION);
    const all = [["SOLO", solo?.[1], Number(solo?.[2]), Number(solo?.[3]), solo?.[4] === "true", solo?.[5]], ...rows];
    // 20261110100000 stops seat sales on the plans it gives unlimited team members.
    const current = all.map(([code, name, entities, seats, buySeats, mode]) => [code, name, entities, seats, UNLIMITED_PLANS.includes(code as string) ? false : buySeats, mode]);
    const expected = PRICING_CATALOGUE.map((p) => [p.code, p.name, p.entityCapacity, p.includedSeats, false, p.salesMode]);
    expect(current).toEqual(expected);
    expect([...UNLIMITED_PLANS].sort()).toEqual(PRICING_CATALOGUE.filter((p) => p.membersUnlimited).map((p) => p.code).sort());
    // The Free plan is retired (kept for history, never offered) and no plan can be offered free again.
    expect(CATALOGUE_MIGRATION).toMatch(/SET is_active = false, is_public = false, display_order = NULL, sales_mode = 'retired'/);
    expect(CATALOGUE_MIGRATION).toMatch(/ADD CONSTRAINT chk_cp_no_free_sales CHECK \(sales_mode <> 'free'\)/);
  });
  it("base-plan offer amounts (USD minor units, GLOBAL, non-purchasable) for every self-serve plan and interval", () => {
    const both = MIGRATION + CATALOGUE_MIGRATION;
    const rows = [...both.matchAll(/\('(SOLO|PRACTICE|FIRM)',\s*'CFOCLOSE_(?:SOLO|PRACTICE|FIRM)_GLOBAL_USD_\w+',\s*(\d+)::bigint,\s*'(MONTHLY|ANNUAL)'\)/g)].map((m) => `${m[1]}:${m[3]}:${m[2]}`).sort();
    const expected = PRICING_CATALOGUE.flatMap((p) => (p.monthlyMinor === null ? [] : [`${p.code}:MONTHLY:${p.monthlyMinor}`, `${p.code}:ANNUAL:${p.annualMinor}`])).sort();
    expect(rows).toEqual(expected);
    for (const m of [MIGRATION, CATALOGUE_MIGRATION]) {
      expect(m).toMatch(/SELECT v\.offer_code, cp\.id, 'GLOBAL', 'USD', v\.amount, 2, v\.billing_interval, 1/);
      expect(m).not.toMatch(/is_purchasable\s*=\s*true/i);
    }
  });
  it("the proposed additional-seat prices (never purchasable) are retired by 20261110100000 — inactive, never deleted", () => {
    expect(MIGRATION).toMatch(/INSERT INTO public\.commercial_additional_seat_prices/);
    expect(MIGRATION).toMatch(/is_purchasable\s+BOOLEAN\s+NOT NULL DEFAULT false/);
    expect(UNLIMITED_MIGRATION).toMatch(/UPDATE public\.commercial_additional_seat_prices SET is_active = false\s+WHERE is_active AND plan_id IN \(SELECT cp\.id FROM public\.commercial_plans cp JOIN public\.commercial_products p ON p\.id = cp\.product_id\s+WHERE p\.code = 'CFOCLOSE' AND cp\.code IN \('PRACTICE','FIRM'\)\)/);
    expect(UNLIMITED_MIGRATION).not.toMatch(/DELETE FROM public\.commercial_additional_seat_prices/);
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
      .filter((f) => /\$(20|200|99|990|299|2,990|49|490|499)\b|\b(4900|49000|9900|99000|29900|299000)\b/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
  it("no customer-visible copy claims bundled user counts", () => {
    const offenders = walk(path.join(ROOT, "src")).filter((f) => /\b(3|10) users\b|up to (3|10) users/i.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
  it("no authorization path reads a price: the resolvers and the walls never mention amounts or offers", () => {
    const authority = MIGRATION.slice(MIGRATION.indexOf("── 5. The entitlement resolver"), MIGRATION.indexOf("── 11. Admin overrides"));
    expect(authority).not.toMatch(/amount_minor|commercial_offers|seat_prices|price/i);
    const resolver = CATALOGUE_MIGRATION.slice(CATALOGUE_MIGRATION.indexOf("── 4. Current plan of an account"), CATALOGUE_MIGRATION.indexOf("── 7. Seats"));
    expect(resolver).not.toMatch(/amount_minor|commercial_offers|seat_prices|price/i);
  });
});
