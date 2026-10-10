/**
 * Safe pre-payment UX: no checkout or payment provider exists, so no public or in-app surface may offer or imply one.
 * Every action is non-transactional ("Request access", "Contact sales", "Talk to us"); plans are activated by the team.
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

import { CHECKOUT_AVAILABLE, NO_CHECKOUT_NOTICE } from "../pricingCatalogue";
import * as COPY from "@/constants/copy";
import * as LANDING from "@/content/landing/landingContent";
import { CheckoutUpgradeButton } from "@/components/commercial/CheckoutUpgradeButton";
import Pricing from "@/pages/Pricing";
import Plans from "@/pages/Plans";

const ROOT = path.join(__dirname, "../../../..");
// Wording that claims or invites a payment step that does not exist.
const TRANSACTIONAL = /\b(Buy( now)?|Subscribe|Start free|Start (a |your )?(free )?trial|Free trial|Pay now|Checkout now|Upgrade Plan|Secure payment|Preparing checkout|temporarily unavailable)\b/i;
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ");

describe("no surface claims that an unavailable checkout exists", () => {
  it("checkout is not available in this build, and the notice says so plainly", () => {
    expect(CHECKOUT_AVAILABLE).toBe(false);
    expect(NO_CHECKOUT_NOTICE).toMatch(/online payment is not available/i);
    expect(NO_CHECKOUT_NOTICE).not.toMatch(TRANSACTIONAL);
  });
  it("public copy (landing content and shared copy) offers only non-transactional actions", () => {
    const all = JSON.stringify({ COPY, LANDING });
    expect(all).not.toMatch(TRANSACTIONAL);
    // Subscriptions are sold by agreement and activated manually: the public primary action is the activation REQUEST.
    expect(LANDING.LANDING_HERO.primaryCta.label).toBe("Request activation");
    expect(COPY.CTA.primary).toBe("Request activation");
  });
  it("no public copy invites self-serve workspace creation: the closing call to action says the team activates workspaces because online payment (checkout) is unavailable", () => {
    const all = JSON.stringify({ COPY, LANDING });
    expect(all).not.toMatch(/Create a workspace and explore|explore CFOCLOSE/i);
    expect(LANDING.LANDING_FINAL_CTA.supporting).toMatch(/there is no online payment/);
    expect(LANDING.LANDING_FINAL_CTA.primaryCta.label).toBe("Request activation");
  });
  it("the rendered pricing page has no payment action and states that there is no online checkout", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Pricing)));
    expect(text(html)).not.toMatch(TRANSACTIONAL);
    expect(text(html)).toContain("Online payment is not available yet.");
    expect(html).not.toMatch(/<button[^>]*>[^<]*(Upgrade|Buy|Subscribe|Checkout)/i);
  });
  it("the in-app upgrade control renders no payment button, only the notice", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CheckoutUpgradeButton, { billingStatus: null, planCode: "PAID", billingInterval: "MONTHLY" } as never)));
    expect(html).toContain('data-testid="no-checkout-notice"');
    expect(html).not.toMatch(/<button/);
    expect(text(html)).not.toMatch(TRANSACTIONAL);
  });
  it("Settings uses the current plan panel; no payment provider package is referenced by the client", () => {
    expect(fs.readFileSync(path.join(ROOT, "src/pages/Settings.tsx"), "utf8")).toContain("CurrentPlanPanel");
    const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
    expect(pkg).not.toMatch(/paddle|polar|snippe|stripe|flutterwave|pesapal|selcom/i);
  });
  it("public acquisition is the activation request (account creation only as the gate-off fallback) and the legacy path redirects", () => {
    expect(COPY.CTA.fallbackHref).toBe("/auth?mode=signup");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Plans)));
    expect(text(html)).not.toMatch(/Request access|Send an access request/);
    expect(fs.readFileSync(path.join(ROOT, "src/App.tsx"), "utf8")).toContain('<Route path="/request-access" element={<Navigate to="/pricing" replace />} />');
  });
});
