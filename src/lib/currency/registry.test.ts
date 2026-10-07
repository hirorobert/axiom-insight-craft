import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENCY_REGISTRY, CURRENCY_REGISTRY_VERSION } from "./registry";
import { CURRENCY_REGISTRY as ENGINE_REGISTRY, CURRENCY_REGISTRY_VERSION as ENGINE_VERSION } from "../../../supabase/functions/_shared/currencyRegistry";
import { CURRENCY_EXPONENTS } from "../../../supabase/functions/_shared/tbIngestion";
import { TB_CURRENCY_EXPONENTS } from "@/lib/accounting/tbAmounts";

const migration = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009100000_currency_registry_and_reporting_periods.sql"), "utf8");
const seeded = Object.fromEntries([...migration.matchAll(/^ {2}\('([A-Z]{3})', (\d), '/gm)].map((m) => [m[1], Number(m[2])]));

// The 53 currencies the engine supported before currency-registry/1, with their exponents (unchanged by the registry).
const BEFORE = { TZS: 2, KES: 2, UGX: 0, RWF: 0, BIF: 0, ETB: 2, ZAR: 2, ZMW: 2, MWK: 2, MZN: 2, NGN: 2, GHS: 2, XOF: 0, XAF: 0,
  EGP: 2, MAD: 2, MUR: 2, SCR: 2, CDF: 2, SSP: 2, SDG: 2, SOS: 2, DJF: 0, BWP: 2, NAD: 2, LSL: 2, SZL: 2, AOA: 2,
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2, SEK: 2, NOK: 2, DKK: 2, CNY: 2, INR: 2, PKR: 2, AED: 2,
  SAR: 2, QAR: 2, JPY: 0, KRW: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, LYD: 3, IQD: 3 };

describe("currency-registry/1", () => {
  it("one version, recorded with its source; the browser copy, the engine copy and the migration seed agree exactly", () => {
    expect(CURRENCY_REGISTRY_VERSION).toBe("iso4217-list-one-2026-09-17");
    expect(ENGINE_VERSION).toBe(CURRENCY_REGISTRY_VERSION);
    expect(CURRENCY_REGISTRY).toEqual(ENGINE_REGISTRY);
    expect(seeded).toEqual({ ...CURRENCY_REGISTRY });
    expect(Object.keys(CURRENCY_REGISTRY)).toHaveLength(155);
    expect(migration).toContain("CHECK (registry_version = 'iso4217-list-one-2026-09-17')");
  });
  it("the engine and the browser validator use the registry", () => {
    expect(CURRENCY_EXPONENTS).toBe(ENGINE_REGISTRY);
    expect(TB_CURRENCY_EXPONENTS).toBe(CURRENCY_REGISTRY);
  });
  it("every currency supported before keeps its exponent (no existing import changes)", () => {
    for (const [code, e] of Object.entries(BEFORE)) expect(CURRENCY_REGISTRY[code], code).toBe(e);
  });
  it("only monetary currencies with exponents the exact engine supports; funds and non-monetary codes are refused", () => {
    for (const e of Object.values(CURRENCY_REGISTRY)) expect([0, 2, 3]).toContain(e);
    for (const code of ["XAU", "XAG", "XDR", "XTS", "XXX", "CLF", "BOV", "USN", "UYW", "CHE", "CHW", "COU", "MXV", "UYI", "XSU", "XUA"]) expect(CURRENCY_REGISTRY[code], code).toBeUndefined();
  });
});

describe("no TZS fallback", () => {
  it("the migration drops the column default; only the legacy v1 path states TZS, explicitly", () => {
    expect(migration).toContain("ALTER TABLE public.fiscal_periods ALTER COLUMN reporting_currency DROP DEFAULT;");
    const tzsLiterals = [...migration.matchAll(/'TZS'(?!, \d, ')/g)].length; // excludes the registry's own seed row
    expect(tzsLiterals).toBe(1);
    expect(migration).toMatch(/auth\.uid\(\), 'TZS', 'v1_calendar_convention'\)/);
  });
  it("no client code creates a period with a default currency", () => {
    const client = readFileSync(resolve(__dirname, "../workspace/workspaceSetupClient.ts"), "utf8");
    expect(client).not.toMatch(/"TZS"|'TZS'/);
  });
});
