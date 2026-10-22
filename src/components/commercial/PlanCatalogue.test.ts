// @vitest-environment jsdom
/**
 * The plans page (owner decision 2026-10-20): two tabs ("Small practices", "Firms"), two cards each, Practice marked
 * "Most popular"; a signed-in NEW card purchase goes straight to the provider in one tap, every other case opens the
 * checkout page, and an open earlier checkout lands on /plans with its banner — never a dead end.
 */
import { act, createElement as h } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, type Mounted } from "@/lib/workbench/testkit/dom";
import { parsePublicPrices } from "@/lib/commercial/planOffers";

const { client } = vi.hoisted(() => ({ client: { getCheckoutOptions: vi.fn(), startCheckout: vi.fn() } }));
vi.mock("@/lib/commercial/checkoutClient", () => client);

import { PlanCatalogue } from "./PlanCatalogue";

const OPEN = parsePublicPrices({ online_payment: true, offers: ["SOLO", "PRACTICE", "FIRM"].map((plan_code, i) => ({ plan_code, market_code: "GLOBAL", currency_code: "USD", currency_exponent: 2, amount_minor: [49000, 99000, 299000][i], billing_interval: "ANNUAL" })) });
const CARD = { paymentRoute: "CARD", available: true, provider: "POLAR", environment: "production", amountMinor: 49000, currencyCode: "USD", currencyExponent: 2 };

let where = "";
function Where() { where = useLocation().pathname + useLocation().search; return null; }
const at = (path: string, props: Record<string, unknown>) => h(MemoryRouter, { initialEntries: [path] }, h(Routes, null,
  h(Route, { path: "*", element: h("div", null, h(PlanCatalogue, props), h(Where)) })));
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const byTestId = (m: Mounted, id: string) => m.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const visible = (m: Mounted, id: string) => !byTestId(m, id)!.closest("[hidden]");

let m: Mounted | null = null;
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  assign = vi.fn();
  Object.defineProperty(window, "location", { value: { ...window.location, assign }, configurable: true });
});
afterEach(() => { m?.unmount(); m = null; });

describe("plan groups", () => {
  it("Small practices first (Solo, Practice); Firms on its tab (Firm, Enterprise); Practice is marked Most popular", async () => {
    m = mount(at("/plans", { prices: OPEN }));
    expect(byTestId(m, "plan-tab-small")!.getAttribute("aria-selected")).toBe("true");
    expect(visible(m, "plan-SOLO") && visible(m, "plan-PRACTICE")).toBe(true);
    expect(visible(m, "plan-FIRM") || visible(m, "plan-ENTERPRISE")).toBe(false);
    expect(byTestId(m, "plan-badge-PRACTICE")!.textContent).toBe("Most popular");
    expect(m.container.querySelectorAll("[data-testid^='plan-badge-']").length).toBe(1);
    click(byTestId(m, "plan-tab-firms")!);
    expect(visible(m, "plan-FIRM") && visible(m, "plan-ENTERPRISE")).toBe(true);
    expect(visible(m, "plan-SOLO")).toBe(false);
    expect(byTestId(m, "contact-support-ENTERPRISE")!.textContent).toBe("Talk to us");
    expect(await axeViolations(m.container)).toEqual([]);
  });
  it("?tab=firms opens the Firms tab", () => {
    m = mount(at("/plans?tab=firms", { prices: OPEN }));
    expect(byTestId(m, "plan-tab-firms")!.getAttribute("aria-selected")).toBe("true");
  });
  it("the price is one large figure with 'per year'; the card names no payment method", () => {
    m = mount(at("/plans", { prices: OPEN }));
    const price = byTestId(m, "price-SOLO")!;
    expect(price.querySelector("p")!.textContent).toBe("USD 490");
    expect(price.textContent).toContain("per year");
    expect(price.textContent).not.toMatch(/card/i);
    expect(byTestId(m, "choose-plan-SOLO")!.textContent).toBe("Get Solo");
  });
});

describe("one tap to the provider", () => {
  it("signed in, one production card route, a NEW purchase: straight to the provider's https page", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: { planCode: "SOLO", placement: { kind: "NEW" }, options: [CARD] }, error: null });
    client.startCheckout.mockResolvedValue({ ok: true, saffReference: "SAFF-1", checkoutUrl: "https://polar.sh/checkout/x", provider: "POLAR", paymentRoute: "CARD", reused: false });
    m = mount(at("/plans", { prices: OPEN, signedIn: true }));
    click(byTestId(m, "choose-plan-SOLO")!);
    await flush();
    expect(client.startCheckout).toHaveBeenCalledWith("SOLO", "CARD", null);
    expect(assign).toHaveBeenCalledWith("https://polar.sh/checkout/x");
  });
  for (const [label, data] of [
    ["a renewal", { planCode: "SOLO", placement: { kind: "AT_RENEWAL" }, options: [CARD] }],
    ["a sandbox route", { planCode: "SOLO", placement: { kind: "NEW" }, options: [{ ...CARD, environment: "sandbox" }] }],
    ["two routes", { planCode: "SOLO", placement: { kind: "NEW" }, options: [CARD, { ...CARD, paymentRoute: "MOBILE_MONEY" }] }],
  ] as const) {
    it(`${label}: the checkout page explains it; nothing is started`, async () => {
      client.getCheckoutOptions.mockResolvedValue({ data, error: null });
      m = mount(at("/plans", { prices: OPEN, signedIn: true }));
      click(byTestId(m, "choose-plan-SOLO")!);
      await flush();
      expect(client.startCheckout).not.toHaveBeenCalled();
      expect(where).toBe("/billing/checkout?plan=SOLO");
    });
  }
  it("an open earlier checkout: lands on /plans with that order named (its banner offers Resume or Choose another plan)", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: { planCode: "SOLO", placement: { kind: "NEW" }, options: [CARD] }, error: null });
    client.startCheckout.mockResolvedValue({ ok: false, error: "OPEN_CHECKOUT_OTHER_PLAN", saffReference: "SAFF-OLD" });
    m = mount(at("/plans", { prices: OPEN, signedIn: true }));
    click(byTestId(m, "choose-plan-SOLO")!);
    await flush();
    expect(where).toBe("/plans?unfinished=SAFF-OLD");
    expect(assign).not.toHaveBeenCalled();
  });
  it("signed out: the link opens the checkout page (sign-in first); nothing is read or started", async () => {
    m = mount(at("/plans", { prices: OPEN }));
    click(byTestId(m, "choose-plan-SOLO")!);
    await flush();
    expect(client.getCheckoutOptions).not.toHaveBeenCalled();
    expect(where).toBe("/billing/checkout?plan=SOLO");
  });
});
