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

const ROOT = path.join(__dirname, "../../../..");
// Wording that claims or invites a payment step that does not exist.
const TRANSACTIONAL = /\b(Buy( now)?|Subscribe|Start free|Start (a |your )?(free )?trial|Free trial|Pay now|Checkout now|Upgrade Plan|Secure payment|Preparing checkout|temporarily unavailable)\b/i;
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ");

describe("no surface claims that an unavailable checkout exists", () => {
  it("checkout is not available in this build, and the notice says so plainly", () => {
    expect(CHECKOUT_AVAILABLE).toBe(false);
    expect(NO_CHECKOUT_NOTICE).toMatch(/no online checkout/i);
    expect(NO_CHECKOUT_NOTICE).not.toMatch(TRANSACTIONAL);
  });
  it("public copy (landing content and shared copy) offers only non-transactional actions", () => {
    const all = JSON.stringify({ COPY, LANDING });
    expect(all).not.toMatch(TRANSACTIONAL);
    expect(LANDING.LANDING_HERO.primaryCta.label).toBe("Request access");
    expect(COPY.CTA.primary).toBe("Request access");
  });
  it("the rendered pricing page has no payment action and states that there is no online checkout", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Pricing)));
    expect(text(html)).not.toMatch(TRANSACTIONAL);
    expect(text(html)).toContain("There is no online checkout.");
    expect(html).not.toMatch(/<button[^>]*>[^<]*(Upgrade|Buy|Subscribe|Checkout)/i);
  });
  it("the in-app upgrade control renders no payment button, only the notice", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CheckoutUpgradeButton, { billingStatus: null, planCode: "PAID", billingInterval: "MONTHLY" } as never)));
    expect(html).toContain('data-testid="no-checkout-notice"');
    expect(html).not.toMatch(/<button/);
    expect(text(html)).not.toMatch(TRANSACTIONAL);
  });
  it("Settings mounts the renewal control only when checkout exists; no payment provider code or keys are referenced by the client", () => {
    expect(fs.readFileSync(path.join(ROOT, "src/pages/Settings.tsx"), "utf8")).toMatch(/\{CHECKOUT_AVAILABLE && billing\.planCode === "PAID"/);
    const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
    expect(pkg).not.toMatch(/paddle|polar|snippe|stripe|flutterwave|pesapal|selcom/i);
  });
});
