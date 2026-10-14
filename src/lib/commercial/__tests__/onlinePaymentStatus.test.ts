import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { providerConfigDiagnostics, polarSettingIssues, providersFromEnv } from "../../../../supabase/functions/_shared/payments/routing.ts";
import { accountEligibility, isCheckoutOptions, parseProviderDiagnostics, platformLabel, providerLine } from "../onlinePaymentStatus";

const ORG = "ac0301f1-7672-4ce4-8721-3a1a3fa69b9d";
const PRODUCTS = { SOLO: "11111111-1111-4111-8111-111111111111", PRACTICE: "22222222-2222-4222-8222-222222222222", FIRM: "33333333-3333-4333-8333-333333333333" };
const prod: Record<string, string | undefined> = {
  SAFF_PAYMENT_REDIRECT_URL: "https://cfoclose.com/billing/payment/return", POLAR_ENVIRONMENT: "production",
  POLAR_ACCESS_TOKEN: "polar_oat_secret_value", POLAR_WEBHOOK_SECRET: "whsec_secret_value", POLAR_ORGANIZATION_ID: ORG, POLAR_PRODUCT_IDS: JSON.stringify(PRODUCTS),
};
const env = (e: Record<string, string | undefined>) => (n: string) => e[n];

describe("provider settings diagnostics (one validator, names only)", () => {
  it("complete production Polar is CONFIGURED independently of payment state; Snippe stays unavailable", () => {
    const d = providerConfigDiagnostics(env(prod));
    expect(d[0]).toEqual({ provider: "POLAR", route: "CARD", status: "CONFIGURED", environment: "production", missingSettings: [] });
    expect(d[1]).toMatchObject({ provider: "SNIPPE", status: "UNAVAILABLE", unavailableReason: "NOT_LAUNCHED" });
    expect(providersFromEnv(env(prod)).map((p) => p.capabilities.provider)).toEqual(["POLAR"]);
  });
  it("missing settings are named, never valued", () => {
    const d = providerConfigDiagnostics(env({ ...prod, POLAR_ORGANIZATION_ID: undefined, POLAR_WEBHOOK_SECRET: "not-whsec" }));
    expect(d[0].status).toBe("INCOMPLETE");
    expect(d[0].missingSettings).toEqual(["POLAR_WEBHOOK_SECRET", "POLAR_ORGANIZATION_ID"]);
    expect(JSON.stringify(d)).not.toMatch(/secret_value|polar_oat/);
  });
  it("the diagnostics and the router agree for every single missing setting", () => {
    for (const k of Object.keys(prod)) {
      const e = env({ ...prod, [k]: undefined });
      expect(polarSettingIssues(e)).toContain(k);
      expect(providersFromEnv(e)).toEqual([]);
    }
  });
});

describe("edge function contract", () => {
  const src = readFileSync("supabase/functions/commercial-create-checkout/index.ts", "utf8");
  const diag = src.slice(src.indexOf("diagnostics') === '1'"), src.indexOf("// ── GET: what this plan costs"));
  it("diagnostics are refused unless the caller is an active commercial administrator, and write nothing", () => {
    expect(diag).toMatch(/rpc\('is_commercial_admin'\)/);
    expect(diag).toMatch(/isAdmin !== true\) return jsonResponse\(\{ error: 'NOT_A_COMMERCIAL_ADMIN'/);
    expect(diag).toMatch(/adminErr\) return jsonResponse\(\{ error: 'ADMIN_CHECK_FAILED'/);
    expect(diag).not.toMatch(/\.insert\(|\.update\(|acquire_checkout_attempt|begin_provider_checkout_request/);
  });
  it("payments disabled keeps the resolver's reason; an RPC error is not 'no offer'", () => {
    expect(src).toMatch(/offer\.reason === 'PLATFORM_PAYMENTS_DISABLED' \? 'PAYMENTS_DISABLED'/);
    expect(src).toMatch(/if \(offerErr\) \{ options\.push\(\{ paymentRoute: route, available: false, reason: 'OFFER_READ_FAILED' \}\)/);
  });
});

describe("administrator screen presentation", () => {
  it("parses diagnostics; malformed answers are refused", () => {
    expect(parseProviderDiagnostics({ providers: providerConfigDiagnostics(env(prod)) })).toHaveLength(2);
    expect(parseProviderDiagnostics(null)).toBeNull();
    expect(parseProviderDiagnostics({ providers: [{ provider: "POLAR", route: "CARD", status: "OK", environment: null, missingSettings: [] }] })).toBeNull();
    expect(parseProviderDiagnostics({ providers: [{ provider: "POLAR", route: "CARD", status: "INCOMPLETE", environment: null, missingSettings: ["polar_oat_x value"] }] })).toBeNull();
    expect(isCheckoutOptions({ nope: 1 })).toBe(false);
  });
  it("configured does not claim provider verification or open payments", () => {
    const [polar] = providerConfigDiagnostics(env(prod));
    expect(providerLine(polar)).toMatch(/settings complete \(production\)\. Not a check/);
  });
  it("payments disabled reads 'Payments disabled', not 'No purchasable offer'", () => {
    expect(platformLabel("PAYMENTS_DISABLED")).toBe("Payments disabled");
    const e = accountEligibility({ planCode: "SOLO", platformState: "PAYMENTS_DISABLED", placement: { kind: "NEW" },
      options: [{ paymentRoute: "CARD", available: false, reason: "PAYMENTS_DISABLED" }, { paymentRoute: "MOBILE_MONEY", available: false, reason: "PAYMENTS_DISABLED" }] });
    expect(e.allowed).toBe(false);
    expect(e.lines[0]).toBe("Card: refused — Payments disabled");
    expect(e.lines.join()).not.toMatch(/No approved price/);
  });
  it("LIVE_ACCEPTANCE: the allow-listed tester is allowed, another account is refused (server's answer shown as-is)", () => {
    const base = { planCode: "SOLO", platformState: "LIVE_ACCEPTANCE", placement: { kind: "NEW" as const } };
    expect(accountEligibility({ ...base, options: [{ paymentRoute: "CARD", available: true, provider: "POLAR", environment: "production" }] }).lines).toEqual(["Card: allowed"]);
    expect(accountEligibility({ ...base, options: [{ paymentRoute: "CARD", available: false, reason: "PAYMENTS_NOT_OPEN" }] }).lines[0]).toMatch(/refused — Not open for this account/);
  });
});
