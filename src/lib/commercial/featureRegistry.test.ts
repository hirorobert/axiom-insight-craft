import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CAPABILITIES,
  CAPABILITY_CODES,
  FEATURE_CODES,
  FEATURE_DESCRIPTIONS,
  LEGACY_CAPABILITY_ALIASES,
  PAID_CAPABILITY_CODES,
  canonicalCapability,
  isFeatureCode,
} from "./featureRegistry";

const MIGRATION = fs.readFileSync(
  path.join(__dirname, "../../../supabase/migrations/20260925100000_global_capabilities_entitlements_pricing.sql"),
  "utf-8",
);

describe("canonical capability vocabulary", () => {
  it("is exactly the six global capability codes, no duplicates, no engine names", () => {
    expect([...CAPABILITY_CODES]).toEqual([
      "CLOSE_ASSURANCE",
      "COMPARATIVE_REPORTING",
      "STATEMENT_CERTIFICATION",
      "REPORTING_PACK_EXPORT",
      "CLOSE_INSIGHTS",
      "ENTITY_CAPACITY",
    ]);
    expect(new Set(CAPABILITY_CODES).size).toBe(CAPABILITY_CODES.length);
    for (const c of CAPABILITY_CODES) expect(c).not.toMatch(/SAFISHA|HESABU|MAONO|KINGA|MULTI_/);
    expect(FEATURE_CODES).toBe(CAPABILITY_CODES);
  });

  it("kinds: two included (never a wall), three paid, one capacity", () => {
    expect(CAPABILITY_CODES.filter((c) => CAPABILITIES[c].kind === "included")).toEqual(["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING"]);
    expect([...PAID_CAPABILITY_CODES]).toEqual(["STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS"]);
    expect(CAPABILITIES.ENTITY_CAPACITY.kind).toBe("capacity");
  });

  it("customer names are the global product names", () => {
    expect(CAPABILITY_CODES.map((c) => CAPABILITIES[c].name)).toEqual([
      "Close Assurance", "Comparative Reporting", "Close Certification", "Reporting Pack", "Close Insights", "Entity Capacity",
    ]);
    for (const c of CAPABILITY_CODES) {
      expect(FEATURE_DESCRIPTIONS[c]).toBeTruthy();
      expect(FEATURE_DESCRIPTIONS[c]).not.toMatch(/Safisha|Hesabu|Maono|Kinga|SAFISHA|HESABU|MAONO|KINGA/);
    }
  });
});

describe("legacy identifiers resolve deterministically (compatibility lookup)", () => {
  it.each(Object.entries(LEGACY_CAPABILITY_ALIASES))("%s → %s", (legacy, canonical) => {
    expect(canonicalCapability(legacy)).toBe(canonical);
    expect(isFeatureCode(legacy)).toBe(false); // a legacy code is never itself canonical
  });
  it("MULTI_PERIOD maps to an INCLUDED capability (comparatives are never a paywall)", () => {
    expect(CAPABILITIES[canonicalCapability("MULTI_PERIOD")!].kind).toBe("included");
  });
  it("unknown, empty, casing variants and non-strings fail closed", () => {
    for (const v of ["UNKNOWN_THING", "", "close_insights", "CLOSE-INSIGHTS", null, undefined, 3]) expect(canonicalCapability(v)).toBeNull();
  });
});

describe("registry stays in lockstep with 20260925100000", () => {
  it("the migration seeds exactly these capabilities with the same kinds and names", () => {
    const block = MIGRATION.slice(MIGRATION.indexOf("INSERT INTO public.commercial_capabilities"), MIGRATION.indexOf("CREATE TABLE public.commercial_capability_aliases"));
    const rows = [...block.matchAll(/\('([A-Z_]+)',\s*'(included|paid|capacity)',\s*'([^']+)'/g)].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual(CAPABILITY_CODES.map((c) => [c, CAPABILITIES[c].kind, CAPABILITIES[c].name]));
  });
  it("the migration seeds exactly these legacy aliases", () => {
    const block = MIGRATION.slice(MIGRATION.indexOf("INSERT INTO public.commercial_capability_aliases"), MIGRATION.indexOf("-- Canonical code for a canonical or legacy input"));
    const rows = Object.fromEntries([...block.matchAll(/\('([A-Z_]+)',\s*'([A-Z_]+)'\)/g)].map((m) => [m[1], m[2]]));
    expect(rows).toEqual(LEGACY_CAPABILITY_ALIASES);
  });
  it("both database CHECK constraints (plans and overrides) list exactly the canonical codes", () => {
    const planCheck = /chk_cp_feature_codes CHECK \(feature_codes <@ ARRAY\[([\s\S]*?)\]/.exec(MIGRATION)?.[1] ?? "";
    const overrideCheck = /chk_eo_feature_code CHECK \(feature_code IN \(([\s\S]*?)\)\)/.exec(MIGRATION)?.[1] ?? "";
    for (const block of [planCheck, overrideCheck]) {
      expect([...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...CAPABILITY_CODES].sort());
    }
  });
});
