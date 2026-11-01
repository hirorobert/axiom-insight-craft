import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CURRENCY_REGISTRY } from "./registry";
import { ADD_COMPANY_FEATURED_CURRENCIES, filterCurrencies, orderedCurrencyOptions } from "./currencyOptions";

// The Add company form used to offer nine hard-coded currencies although the reader and the database support the whole
// ISO 4217 registry, so an Australian or Canadian user could not create a workspace in their own currency.

const CODES = Object.keys(CURRENCY_REGISTRY);
const options = () => orderedCurrencyOptions(CODES, ADD_COMPANY_FEATURED_CURRENCIES);

describe("Add company currency options", () => {
  it("offers every registry currency exactly once, and nothing the registry does not hold", () => {
    const codes = options().map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual([...CODES].sort());
    for (const c of codes) expect(CURRENCY_REGISTRY[c], c).toBeTypeOf("number");
  });

  it("includes the currencies that were missing (Australian and Canadian dollars) and non-two-decimal ones", () => {
    const codes = new Set(options().map((o) => o.code));
    for (const c of ["AUD", "CAD", "NZD", "INR", "JPY", "BHD"]) expect(codes.has(c), c).toBe(true);
    expect(CURRENCY_REGISTRY.JPY).toBe(0);
    expect(CURRENCY_REGISTRY.BHD).toBe(3);
  });

  it("keeps the nine familiar currencies first, in their order, then the rest alphabetically", () => {
    const codes = options().map((o) => o.code);
    expect(codes.slice(0, 9)).toEqual(["USD", "EUR", "GBP", "GHS", "KES", "NGN", "TZS", "UGX", "ZAR"]);
    const rest = codes.slice(9);
    expect(rest).toEqual([...rest].sort());
  });

  it("is found by code or by name through the same search the selector uses", () => {
    const o = options();
    expect(filterCurrencies(o, "aud").map((x) => x.code)).toContain("AUD");
    expect(filterCurrencies(o, "canadian").map((x) => x.code)).toContain("CAD");
    expect(filterCurrencies(o, "zzzz")).toEqual([]);
  });

  it("refuses a featured currency the registry does not hold, so the list can never offer one the server would reject", () => {
    expect(() => orderedCurrencyOptions(["USD", "EUR"], ["USD", "XYZ"])).toThrow(/XYZ/);
    expect(orderedCurrencyOptions(["USD", "EUR", "AUD"], ["USD"]).map((x) => x.code)).toEqual(["USD", "AUD", "EUR"]);
  });

  it("every featured currency is in the registry", () => {
    for (const c of ADD_COMPANY_FEATURED_CURRENCIES) expect(CURRENCY_REGISTRY[c], c).toBeTypeOf("number");
  });
});

describe("the Add company form takes its currencies from the registry", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../components/workspace/FirstRunEngagement.tsx"), "utf8");
  it("builds the options from the registry and no longer hard-codes a currency list", () => {
    expect(src).toContain("orderedCurrencyOptions(Object.keys(CURRENCY_REGISTRY), ADD_COMPANY_FEATURED_CURRENCIES)");
    expect(src).not.toMatch(/value:\s*"(USD|EUR|GBP|TZS)"/);
  });
  it("still has no default currency: the field starts empty and submit waits for a choice", () => {
    expect(src).toContain('const [currency, setCurrency]       = useState("");');
    expect(src).toMatch(/canSubmit = orgName\.trim\(\)\.length > 0 && currency\.length > 0/);
  });
});
