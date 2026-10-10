/**
 * Honest payment claims. Online purchase exists, but whether it is OPEN is a server fact (get_public_plan_prices:
 * an approved price AND commercial_platform_state = CUSTOMER_PAYMENTS_ENABLED). Static copy therefore never claims or
 * invites a payment step; only the per-plan view built from the server's answer (planOffers.ts) may offer
 * "Choose <plan>" → /billing/checkout, and every surface falls back to the activation request when payment is not open.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null, session: null, loading: false, signOut: async () => undefined }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) }, rpc: async () => ({ data: null, error: null }) },
}));

import { CHECKOUT_AVAILABLE, NO_CHECKOUT_NOTICE, PRICING_CATALOGUE } from "../pricingCatalogue";
import { parsePublicPrices, planPurchaseView } from "../planOffers";
import * as COPY from "@/constants/copy";
import * as LANDING from "@/content/landing/landingContent";
import { CheckoutUpgradeButton } from "@/components/commercial/CheckoutUpgradeButton";
import { PlanCatalogue } from "@/components/commercial/PlanCatalogue";
import Pricing from "@/pages/Pricing";
import Plans from "@/pages/Plans";

const ROOT = path.join(__dirname, "../../../..");
// Wording that claims or invites a payment step on its own (static copy may never use it).
const TRANSACTIONAL = /\b(Buy( now)?|Subscribe|Start free|Start (a |your )?(free )?trial|Free trial|Pay now|Checkout now|Upgrade Plan|Secure payment|Preparing checkout|temporarily unavailable)\b/i;
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ");
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

describe("static copy never claims online payment", () => {
  it("public copy (landing content and shared copy) has no transactional wording and no claim that payment is or is not available", () => {
    const all = JSON.stringify({ COPY, LANDING });
    expect(all).not.toMatch(TRANSACTIONAL);
    // These sentences would be false in one of the two server states, so static copy contains neither.
    expect(all).not.toMatch(/there is no online (payment|checkout)|online payment is available|pay online now/i);
    // The primary public action is the plans; the activation request is always reachable.
    expect(LANDING.LANDING_HERO.primaryCta.label).toBe("Explore plans");
    expect(LANDING.LANDING_HERO.secondaryCta.label).toBe("Request activation");
    expect(LANDING.LANDING_FINAL_CTA.primaryCta.href).toBe("#plans");
  });
  it("no public copy invites self-serve workspace creation", () => {
    expect(JSON.stringify({ COPY, LANDING })).not.toMatch(/Create a workspace and explore|explore CFOCLOSE/i);
  });
  it("the legacy in-app upgrade control renders no payment button, only its notice", () => {
    expect(CHECKOUT_AVAILABLE).toBe(false);
    const html = render(createElement(CheckoutUpgradeButton, { billingStatus: null, planCode: "PAID", billingInterval: "MONTHLY" } as never));
    expect(html).toContain('data-testid="no-checkout-notice"');
    expect(html).not.toMatch(/<button/);
    expect(text(html)).toContain(NO_CHECKOUT_NOTICE);
  });
});

describe("payment is offered only where the server says it is open", () => {
  const OPEN = parsePublicPrices({ online_payment: true, offers: [{ plan_code: "SOLO", market_code: "GLOBAL", currency_code: "USD", currency_exponent: 2, amount_minor: 49000, billing_interval: "ANNUAL" }] });
  const CLOSED = parsePublicPrices({ online_payment: false, offers: [{ plan_code: "SOLO", market_code: "GLOBAL", currency_code: "USD", currency_exponent: 2, amount_minor: 49000, billing_interval: "ANNUAL" }] });

  it("the rendered pricing and plans pages (no server answer yet) offer only activation requests and the proposed figures", () => {
    for (const page of [Pricing, Plans]) {
      const html = render(createElement(page));
      expect(text(html)).not.toMatch(TRANSACTIONAL);
      expect(html).not.toContain("/billing/checkout");
      expect(text(html)).toContain("Proposed: USD 490 per year");
      expect(html).not.toMatch(/<button[^>]*>[^<]*(Upgrade|Buy|Subscribe|Checkout)/i);
    }
  });
  it("the catalogue offers 'Choose <plan>' to checkout only for a plan with an approved price while payment is open", () => {
    const open = render(createElement(PlanCatalogue, { prices: OPEN }));
    expect(open).toContain('href="/billing/checkout?plan=SOLO"');
    expect(text(open)).toContain("USD 490 per year by card");
    expect(open).not.toContain('href="/billing/checkout?plan=PRACTICE"');
    const closed = render(createElement(PlanCatalogue, { prices: CLOSED }));
    expect(closed).not.toContain("/billing/checkout");
    expect(text(closed)).toContain("Proposed: USD 490 per year");
  });
  it("planPurchaseView never invents a price: an online price is the server's amount; otherwise the catalogue's, marked Proposed", () => {
    const solo = PRICING_CATALOGUE.find((p) => p.code === "SOLO")!;
    const odd = parsePublicPrices({ online_payment: true, offers: [{ plan_code: "SOLO", market_code: "GLOBAL", currency_code: "USD", currency_exponent: 2, amount_minor: 51234, billing_interval: "ANNUAL" }] });
    expect(planPurchaseView(solo, odd, "landing_plans").priceLines).toEqual(["USD 512.34 per year by card"]);
    expect(planPurchaseView(solo, null, "landing_plans")).toMatchObject({ mode: "activation", priceLines: ["Proposed: USD 490 per year"] });
    expect(parsePublicPrices({ online_payment: true, offers: [{ plan_code: "SOLO", amount_minor: -1 }] })?.offers).toEqual([]);
    expect(parsePublicPrices("nonsense")).toBeNull();
  });
  it("Settings uses the current plan panel; no payment provider package is referenced by the client (adapters use fetch server-side only)", () => {
    expect(fs.readFileSync(path.join(ROOT, "src/pages/Settings.tsx"), "utf8")).toContain("CurrentPlanPanel");
    const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
    expect(pkg).not.toMatch(/paddle|polar|snippe|stripe|flutterwave|pesapal|selcom/i);
  });
  it("public acquisition keeps the activation request reachable and the legacy path redirects", () => {
    expect(COPY.CTA.fallbackHref).toBe("/auth?mode=signup");
    const html = render(createElement(Plans));
    expect(text(html)).not.toMatch(/Request access|Send an access request/);
    expect(fs.readFileSync(path.join(ROOT, "src/App.tsx"), "utf8")).toContain('<Route path="/request-access" element={<Navigate to="/pricing" replace />} />');
  });
});
