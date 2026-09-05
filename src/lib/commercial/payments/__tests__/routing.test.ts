/**
 * Ω2-G Test Matrix — Provider Routing
 *
 * Provider routing is downstream of commercial offer resolution. It never
 * encodes "currency => provider" as a fixed rule — each configured
 * provider declares capabilities, and selection is a pure function over
 * (offer, configured providers).
 */

import { describe, it, expect } from "vitest";
import { selectPaymentProvider, FLUTTERWAVE_CAPABILITIES, type PaymentProviderCapabilities } from "../routing";

const STRIPE_MOCK_CAPABILITIES: PaymentProviderCapabilities = {
  provider: "STRIPE",
  supportedCurrencies: ["USD", "GBP", "EUR"],
  supportedMarkets: ["GLOBAL", "GB", "EU"],
  supportedMethods: ["card"],
  environment: "sandbox",
};

describe("selectPaymentProvider — Flutterwave eligible routing", () => {
  it("routes a TZS/TZ offer to Flutterwave when configured", () => {
    const result = selectPaymentProvider(
      { currencyCode: "TZS", marketCode: "TZ", providerRestriction: null },
      [FLUTTERWAVE_CAPABILITIES],
    );
    expect(result).toEqual({ selected: true, provider: "FLUTTERWAVE" });
  });

  it("routes a USD/GLOBAL offer to Flutterwave when configured", () => {
    const result = selectPaymentProvider(
      { currencyCode: "USD", marketCode: "GLOBAL", providerRestriction: null },
      [FLUTTERWAVE_CAPABILITIES],
    );
    expect(result).toEqual({ selected: true, provider: "FLUTTERWAVE" });
  });
});

describe("selectPaymentProvider — fails closed, never a fake checkout", () => {
  it("no configured providers at all -> PAYMENT_PROVIDER_UNAVAILABLE", () => {
    const result = selectPaymentProvider(
      { currencyCode: "USD", marketCode: "GLOBAL", providerRestriction: null },
      [],
    );
    expect(result).toEqual({ selected: false, reason: "PAYMENT_PROVIDER_UNAVAILABLE" });
  });

  it("unsupported market for the only configured provider -> PAYMENT_PROVIDER_UNAVAILABLE", () => {
    // Flutterwave capabilities deliberately do not cover GB/EU in Ω2-G.
    const result = selectPaymentProvider(
      { currencyCode: "GBP", marketCode: "GB", providerRestriction: null },
      [FLUTTERWAVE_CAPABILITIES],
    );
    expect(result).toEqual({ selected: false, reason: "PAYMENT_PROVIDER_UNAVAILABLE" });
  });

  it("unsupported currency for the only configured provider -> PAYMENT_PROVIDER_UNAVAILABLE", () => {
    const result = selectPaymentProvider(
      { currencyCode: "JPY", marketCode: "GLOBAL", providerRestriction: null },
      [FLUTTERWAVE_CAPABILITIES],
    );
    expect(result.selected).toBe(false);
  });

  it("provider restriction pointing at an unconfigured provider -> explicit rejection, not fallback", () => {
    const result = selectPaymentProvider(
      { currencyCode: "USD", marketCode: "GLOBAL", providerRestriction: "STRIPE" },
      [FLUTTERWAVE_CAPABILITIES],
    );
    expect(result).toEqual({ selected: false, reason: "OFFER_RESTRICTED_TO_UNAVAILABLE_PROVIDER" });
  });

  it("routing never alters the offer's price or currency — it only returns a provider identifier", () => {
    const offer = { currencyCode: "USD", marketCode: "GLOBAL", providerRestriction: null };
    const before = { ...offer };
    selectPaymentProvider(offer, [FLUTTERWAVE_CAPABILITIES]);
    expect(offer).toEqual(before);
  });
});

describe("Stripe-readiness — a second adapter's capabilities compose without touching core routing logic", () => {
  it("a GB/EU offer becomes routable once a Stripe-capable provider is configured, with zero changes to selectPaymentProvider itself", () => {
    const gbOffer = { currencyCode: "GBP", marketCode: "GB", providerRestriction: null };
    const withOnlyFlutterwave = selectPaymentProvider(gbOffer, [FLUTTERWAVE_CAPABILITIES]);
    expect(withOnlyFlutterwave.selected).toBe(false);

    const withStripeAlso = selectPaymentProvider(gbOffer, [FLUTTERWAVE_CAPABILITIES, STRIPE_MOCK_CAPABILITIES]);
    expect(withStripeAlso).toEqual({ selected: true, provider: "STRIPE" });
  });

  it("a mock Stripe adapter satisfies the same PaymentProviderCapabilities shape Flutterwave uses — no new fields required", () => {
    const keys = Object.keys(STRIPE_MOCK_CAPABILITIES).sort();
    expect(keys).toEqual(Object.keys(FLUTTERWAVE_CAPABILITIES).sort());
  });
});
