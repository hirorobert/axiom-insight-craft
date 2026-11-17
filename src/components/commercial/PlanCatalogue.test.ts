// @vitest-environment jsdom
/**
 * The plans page (owner decision 2026-10-20): two tabs ("Small practices", "Firms"), two cards each, Practice marked
 * "Most popular"; every purchase opens the CFOClose checkout page, which states the term, the merchant of record and the
 * refund terms before anything leaves for the payment page (S2-C02); before the prices are read, no card states a price.
 */
import fs from "node:fs";
import path from "node:path";
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

describe("every purchase opens the CFOClose checkout page (S2-C02)", () => {
  // Formerly a signed-in NEW card purchase went straight to the provider in one tap, skipping the checkout page and its
  // term, merchant-of-record and refund disclosures. Now every "Get <plan>" is a plain link to the checkout page: nothing
  // is read or started from the card, and the checkout page (or the plans page's banner) handles an unfinished checkout.
  it("'Get <plan>' opens the checkout page; nothing is read, started or sent to another origin from the card", async () => {
    m = mount(at("/plans", { prices: OPEN }));
    expect(byTestId(m, "choose-plan-SOLO")!.getAttribute("href")).toBe("/billing/checkout?plan=SOLO");
    click(byTestId(m, "choose-plan-SOLO")!);
    await flush();
    expect(client.getCheckoutOptions).not.toHaveBeenCalled();
    expect(client.startCheckout).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(where).toBe("/billing/checkout?plan=SOLO");
  });
  it("the card holds no path to the provider: no checkout client, no window.location", () => {
    const src = fs.readFileSync(path.join(__dirname, "PlanCatalogue.tsx"), "utf8");
    expect(src).not.toMatch(/checkoutClient|startCheckout|window\.location/);
  });
});

describe("S2-C10 · before the server's prices are read, a card states no commercial position", () => {
  it("prices not yet read: a neutral placeholder for each self-serve plan — no 'Proposed' figure, no Contact support, no payment action", () => {
    m = mount(at("/plans", { prices: null }));
    const t = m.container.textContent ?? "";
    expect(t).not.toMatch(/Proposed/);
    // Nor does it claim payment is open or closed before the server has said which.
    expect(t).not.toMatch(/temporarily unavailable|Contact support/);
    for (const plan of ["SOLO", "PRACTICE", "FIRM"]) {
      expect(byTestId(m, `contact-support-${plan}`), plan).toBeNull();
      expect(byTestId(m, `choose-plan-${plan}`), plan).toBeNull();
      expect(byTestId(m, `price-pending-${plan}`), plan).not.toBeNull();
    }
    // Enterprise does not depend on the price read: its terms are always agreed with the team.
    expect(byTestId(m, "contact-support-ENTERPRISE")!.textContent).toBe("Talk to us");
  });
  it("once read, the cards are as before: nothing purchasable → 'Proposed' and Contact support; open → the price and 'Get <plan>'", () => {
    m = mount(at("/plans", { prices: parsePublicPrices({ online_payment: false, offers: [] }) }));
    expect(byTestId(m, "price-SOLO")!.textContent).toContain("Proposed: USD 490");
    expect(byTestId(m, "contact-support-SOLO")!.textContent).toBe("Contact support");
    expect(byTestId(m, "price-pending-SOLO")).toBeNull();
    m.unmount();
    m = mount(at("/plans", { prices: OPEN }));
    expect(byTestId(m, "price-SOLO")!.querySelector("p")!.textContent).toBe("USD 490");
    expect(byTestId(m, "choose-plan-SOLO")!.textContent).toBe("Get Solo");
    expect(byTestId(m, "price-pending-SOLO")).toBeNull();
  });
});
