/**
 * Ω2 checkout entry-point gap — focused tests.
 *
 * Root cause: CheckoutUpgradeButton suppressed the upgrade action whenever
 * `billingStatus` was ACTIVE/GRACE, without checking whether the customer
 * was already on the plan being offered. Ω1 auto-provisions every new
 * signup with a FREE licence in ACTIVE status, so this suppressed the
 * upgrade action for every FREE customer, not just customers who had
 * already upgraded — the exact "FREE plan / ACTIVE / no upgrade button"
 * gap observed in Settings → Plan & Billing.
 *
 * shouldShowUpgradeAction() and deriveOfferDisplayState() are pure
 * functions extracted from the component specifically so these six
 * required scenarios can be proven directly, without needing a component-
 * rendering test harness (this repository has none — see the established
 * precedent in certificationRevalidationGuard.test.ts and
 * maonoCashflowMath.test.ts for the same extraction technique).
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// CheckoutUpgradeButton.tsx -> commercialRpc.ts statically imports the
// supabase client, which reads `localStorage` at module init time — absent
// under this project's node test environment. The pure functions under
// test never call supabase; mock it out before importing, mirroring the
// established precedent in computeComplianceScore.test.ts.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: vi.fn() },
    from: vi.fn(() => ({ select: vi.fn(), eq: vi.fn(), in: vi.fn(), order: vi.fn(), limit: vi.fn() })),
  },
}));

import {
  shouldShowUpgradeAction,
  deriveOfferDisplayState,
  intervalLabelFor,
} from "./CheckoutUpgradeButton";
import type { LicenceStatus } from "@/lib/commercial/entitlementContract";

const SRC = fs.readFileSync(path.join(__dirname, "CheckoutUpgradeButton.tsx"), "utf-8");

/**
 * Comments legitimately explain e.g. "market code (e.g. \"TZ\")" — strip
 * comments before checking for a hardcoded market literal in actual CODE,
 * mirroring the stripTsComments() technique in webhookEvidenceModel.test.ts.
 */
function stripTsComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const CODE = stripTsComments(SRC);

describe("shouldShowUpgradeAction — Test 1: FREE + available offer -> upgrade action available", () => {
  it("shows the upgrade action for a FREE customer being offered PAID, even though their FREE licence is ACTIVE", () => {
    expect(shouldShowUpgradeAction("FREE", "PAID", "ACTIVE")).toBe(true);
  });

  it("shows it too when the FREE licence is in GRACE", () => {
    expect(shouldShowUpgradeAction("FREE", "PAID", "GRACE")).toBe(true);
  });
});

describe("shouldShowUpgradeAction — Test 6: existing ACTIVE paid licence does not show an inappropriate upgrade action", () => {
  it("suppresses the upgrade action when the customer is already on the target plan and it is ACTIVE", () => {
    expect(shouldShowUpgradeAction("PAID", "PAID", "ACTIVE")).toBe(false);
  });

  it("suppresses it too when the existing same-plan licence is in GRACE", () => {
    expect(shouldShowUpgradeAction("PAID", "PAID", "GRACE")).toBe(false);
  });

  it("does NOT suppress when on the same plan but the licence is not current (e.g. lapsed/none) — a real upgrade/renewal path must remain visible", () => {
    const nonCurrentStatuses: (LicenceStatus | null)[] = [null, "CANCELLED" as LicenceStatus, "EXPIRED" as LicenceStatus];
    for (const status of nonCurrentStatuses) {
      expect(shouldShowUpgradeAction("PAID", "PAID", status)).toBe(true);
    }
  });
});

describe("shouldShowUpgradeAction — fail-open on unknown plan identity, never fail-closed by hiding a legitimate upgrade", () => {
  it("never suppresses when currentPlanCode is null (billing summary not yet loaded / no billing customer)", () => {
    expect(shouldShowUpgradeAction(null, "PAID", "ACTIVE")).toBe(true);
    expect(shouldShowUpgradeAction(undefined, "PAID", "ACTIVE")).toBe(true);
  });

  it("shows the action for a customer on a different plan than the one being offered, even if that other plan is ACTIVE", () => {
    expect(shouldShowUpgradeAction("TRIAL", "PAID", "ACTIVE")).toBe(true);
  });
});

describe("deriveOfferDisplayState — Test 2: FREE + no authoritative offer -> no fabricated checkout", () => {
  it("resolves AVAILABLE only with a real amount_minor and currency_code present", () => {
    const result = deriveOfferDisplayState({
      resolution: "AVAILABLE",
      amount_minor: 100000,
      currency_code: "TZS",
      currency_exponent: 0,
      billing_interval: "MONTHLY",
      billing_interval_count: 1,
    });
    expect(result.phase).toBe("AVAILABLE");
  });

  it("resolves UNAVAILABLE for NOT_AVAILABLE — never approximates a price", () => {
    expect(deriveOfferDisplayState({ resolution: "NOT_AVAILABLE" }).phase).toBe("UNAVAILABLE");
  });

  it("resolves UNAVAILABLE for AMBIGUOUS — never silently guesses between offers", () => {
    expect(deriveOfferDisplayState({ resolution: "AMBIGUOUS" }).phase).toBe("UNAVAILABLE");
  });

  it("resolves UNAVAILABLE for UNKNOWN", () => {
    expect(deriveOfferDisplayState({ resolution: "UNKNOWN" }).phase).toBe("UNAVAILABLE");
  });

  it("resolves UNAVAILABLE for a null/undefined response (RPC failure or no data)", () => {
    expect(deriveOfferDisplayState(null).phase).toBe("UNAVAILABLE");
    expect(deriveOfferDisplayState(undefined).phase).toBe("UNAVAILABLE");
  });

  it("resolves UNAVAILABLE even when resolution says AVAILABLE if amount_minor is missing — never fabricate a price from a malformed response", () => {
    expect(deriveOfferDisplayState({ resolution: "AVAILABLE", currency_code: "TZS" }).phase).toBe("UNAVAILABLE");
  });

  it("resolves UNAVAILABLE even when resolution says AVAILABLE if currency_code is missing", () => {
    expect(deriveOfferDisplayState({ resolution: "AVAILABLE", amount_minor: 100000 }).phase).toBe("UNAVAILABLE");
  });

  it("never derives a display label from anything other than the server-supplied amount_minor/currency_code (no hardcoded TZS 1,000)", () => {
    const result = deriveOfferDisplayState({
      resolution: "AVAILABLE",
      amount_minor: 250000,
      currency_code: "USD",
      currency_exponent: 2,
    });
    expect(result.phase).toBe("AVAILABLE");
    if (result.phase === "AVAILABLE") {
      expect(result.label).toContain("USD");
      expect(result.label).not.toContain("TZS");
    }
  });
});

describe("intervalLabelFor — presentation only, never a pricing decision", () => {
  it("formats known intervals and falls back sanely for unknown ones", () => {
    expect(intervalLabelFor("MONTHLY", 1)).toBe("/ month");
    expect(intervalLabelFor("ONE_TIME", 1)).toBe("one-time");
    expect(intervalLabelFor("ANNUAL", 1)).toBe("/ year");
    expect(intervalLabelFor(undefined, undefined)).toBe("/ year");
  });
});

describe("Test 3 (static): the client can never override amount/currency/price", () => {
  it("handleUpgrade calls createCheckoutIntent with only planCode, billingInterval and marketCode — no amount/currency/price argument, even though the component legitimately DISPLAYS the server-resolved offer's amount/currency elsewhere", () => {
    // The component never constructs its own request body — it delegates
    // entirely to createCheckoutIntent(planCode, billingInterval,
    // marketCode). Scoped to the call site itself (not the whole file)
    // because the file legitimately reads amount_minor/currency_code from
    // the server response to DISPLAY the resolved price — that is
    // presentation, not a client-supplied value.
    const callSite = SRC.match(/await createCheckoutIntent\(([^)]*)\)/);
    expect(callSite).not.toBeNull();
    expect(callSite![1].trim()).toBe("planCode, billingInterval, marketCode");
  });

  it("commercialRpc.ts's createCheckoutIntent request body is exactly { planCode, billingInterval, marketCode } — no amount/currency field", () => {
    const rpcSrc = fs.readFileSync(
      path.join(__dirname, "../../lib/commercial/commercialRpc.ts"),
      "utf-8",
    );
    const fnMatch = rpcSrc.match(/export async function createCheckoutIntent\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/body:\s*JSON\.stringify\(\{\s*planCode,\s*billingInterval,\s*marketCode\s*\}\)/);
    expect(fnBody).not.toMatch(/amount|currency|price/i);
  });
});

describe("Test 4 (static): checkout uses the existing server authority, not a new endpoint", () => {
  it("handleUpgrade calls createCheckoutIntent — the same client function already wired to commercial-create-checkout", () => {
    expect(SRC).toMatch(/const \{ data, error \} = await createCheckoutIntent\(planCode, billingInterval, marketCode\);/);
  });

  it("does not construct any direct fetch()/RPC call of its own — createCheckoutIntent is the sole authority boundary", () => {
    expect(SRC).not.toMatch(/fetch\(/);
    expect(SRC).not.toMatch(/supabase\.rpc\(/);
  });

  it("the pre-flight authenticated-CTA check reads the session only — it never itself creates the checkout or navigates anywhere but /auth", () => {
    expect(SRC).toMatch(/await supabase\.auth\.getSession\(\)/);
    expect(SRC).toMatch(/navigate\("\/auth"\)/);
  });
});

describe("Ω∞ market propagation — DISPLAY_MARKET == CHECKOUT_MARKET, never guessed, never hardcoded", () => {
  it("resolve_commercial_offer (display) is called with p_market_code: marketCode — the same prop, not a derived/guessed value", () => {
    expect(SRC).toMatch(/p_plan_code: planCode,[\s\S]*?p_billing_interval: billingInterval,[\s\S]*?p_market_code: marketCode,/);
  });

  it("createCheckoutIntent (checkout) is called with the identical marketCode identifier used for display resolution — no second, independently-derived market value exists anywhere in this file", () => {
    const marketCodeUses = SRC.match(/\bmarketCode\b/g) ?? [];
    // Prop declaration + doc-comment mentions + the two call sites this
    // test cares about. What matters is there is exactly ONE source
    // variable named `marketCode` in scope (the prop) and both call sites
    // reference it verbatim — proven by the two exact-match assertions
    // above/below, not by counting alone. This count only guards against a
    // second variable being introduced under a different name that shadows
    // or replaces the prop at one call site but not the other.
    expect(marketCodeUses.length).toBeGreaterThanOrEqual(2);
    expect(SRC).toMatch(/p_market_code: marketCode/);
    expect(SRC).toMatch(/createCheckoutIntent\(planCode, billingInterval, marketCode\)/);
  });

  it("never hardcodes the 'TZ' market (or any other specific market literal) anywhere in this file's actual code (comments may illustrate examples)", () => {
    expect(CODE).not.toMatch(/["']TZ["']/);
    expect(CODE).not.toMatch(/["']MU["']/);
    expect(CODE).not.toMatch(/["']GB["']/);
    expect(CODE).not.toMatch(/["']EU["']/);
  });

  it("the marketCode prop carries no default value — omission must resolve via the server's own neutral GLOBAL default, never a client-side guess", () => {
    expect(SRC).toMatch(/planCode = "PAID", billingInterval, marketCode \}: Props/);
    expect(CODE).not.toMatch(/marketCode\s*=\s*["']/);
  });

  it("never infers market from accounting jurisdiction, company/entity country, or browser locale", () => {
    expect(CODE).not.toMatch(/jurisdiction|companyId|company_id|navigator\.language|Intl\.|geolocation/i);
  });

  it("requires no commercial_admin authority anywhere in this customer-facing checkout entry point", () => {
    expect(CODE).not.toMatch(/commercial_admin|is_commercial_admin/i);
  });
});

describe("Ω3-CHECKOUT — DISPLAY_INTERVAL == CHECKOUT_INTERVAL, mandatory, never defaulted", () => {
  it("the billingInterval prop carries no default value in the destructure", () => {
    expect(CODE).not.toMatch(/billingInterval\s*=\s*["']/);
  });

  it("resolve_commercial_offer (display) and createCheckoutIntent (checkout) both use the identical billingInterval identifier", () => {
    const billingIntervalUses = SRC.match(/\bbillingInterval\b/g) ?? [];
    expect(billingIntervalUses.length).toBeGreaterThanOrEqual(2);
    expect(SRC).toMatch(/p_billing_interval: billingInterval/);
    expect(SRC).toMatch(/createCheckoutIntent\(planCode, billingInterval, marketCode\)/);
  });

  it("never hardcodes 'MONTHLY' or 'ANNUAL' as the VALUE passed into either the display-resolution or checkout-creation call — both calls forward the billingInterval prop verbatim, never a literal", () => {
    // Scoped to the two actual call sites (not the whole file):
    // intervalLabelFor's own switch statement legitimately names these
    // literals for PRESENTATION formatting (e.g. "/ month" vs "/ year"),
    // which is not a business/pricing decision and predates this prop.
    expect(CODE).not.toMatch(/p_billing_interval:\s*["'](MONTHLY|ANNUAL)["']/);
    expect(CODE).not.toMatch(/createCheckoutIntent\(planCode,\s*["'](MONTHLY|ANNUAL)["']/);
  });
});

describe("Test 5 (static): checkout failure remains fail-closed", () => {
  it("an error or missing data from createCheckoutIntent returns before any navigation", () => {
    const fnMatch = SRC.match(/async function handleUpgrade\(\) \{[\s\S]*?\n {2}\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    const errorBranch = fnBody.match(/if \(error \|\| !data\) \{([\s\S]*?)\}/);
    expect(errorBranch).not.toBeNull();
    expect(errorBranch![1]).toMatch(/return;/);
    expect(errorBranch![1]).not.toMatch(/window\.location/);
  });

  it("an unexpected thrown error is caught and never reaches navigation either", () => {
    const fnMatch = SRC.match(/async function handleUpgrade\(\) \{[\s\S]*?\n {2}\}/);
    const fnBody = fnMatch![0];
    const catchBranch = fnBody.match(/\} catch \{([\s\S]*?)\} finally/);
    expect(catchBranch).not.toBeNull();
    expect(catchBranch![1]).not.toMatch(/window\.location/);
    expect(catchBranch![1]).toMatch(/toast\.error/);
  });

  it("window.location.href is assigned only from the server-returned checkoutUrl, never a client-constructed URL", () => {
    expect(SRC).toMatch(/window\.location\.href = data\.checkoutUrl;/);
    // No other window.location assignment exists anywhere in the file.
    const navigationAssignments = SRC.match(/window\.location\.href\s*=/g) ?? [];
    expect(navigationAssignments.length).toBe(1);
  });
});

describe("root-cause regression guard: the raw billingStatus-only gate must never reappear", () => {
  it("the suppression check is not a bare billingStatus comparison — it must route through shouldShowUpgradeAction", () => {
    expect(SRC).not.toMatch(/if \(billingStatus === "ACTIVE" \|\| billingStatus === "GRACE"\)/);
    expect(SRC).toMatch(/if \(!shouldShowUpgradeAction\(/);
  });
});
