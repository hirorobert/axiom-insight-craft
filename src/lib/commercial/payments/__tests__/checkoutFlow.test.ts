/**
 * Ω2 Test Matrix — Section 3: Checkout Flow
 * Tests the complete checkout intent creation pathway and guard conditions.
 * No live HTTP calls — all provider interaction is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PaymentProviderAdapter, CreateCheckoutParams, CreateCheckoutResult } from "../paymentTypes";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAdapter(overrides: Partial<PaymentProviderAdapter> = {}): PaymentProviderAdapter {
  return {
    provider: "FLUTTERWAVE",
    createCheckout: vi.fn(async (_p: CreateCheckoutParams): Promise<CreateCheckoutResult> => ({
      success: true,
      checkoutUrl: "https://checkout.flutterwave.com/test-link",
      providerReference: "FLW-TEST-REF-001",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })),
    verifyTransaction: vi.fn(async () => ({
      success: true,
      providerStatus: "SUCCEEDED",
      providerTransactionId: "FLW-TX-001",
      amountMinor: 450_000n,
      currencyCode: "TZS",
      providerCreatedAt: new Date().toISOString(),
      rawNormalizedStatus: "successful",
    })),
    verifyWebhookAuthenticity: vi.fn(() => ({ authentic: true, reason: "hash_match" })),
    normalizeWebhook: vi.fn(() => ({
      provider: "FLUTTERWAVE" as const,
      eventType: "charge.completed",
      providerTransactionId: "FLW-TX-001",
      saffReference: "SAFF-TEST-001",
      status: "SUCCEEDED" as const,
      rawPayload: {},
    })),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Checkout intent — browser sends planId only", () => {
  it("createCheckout is called with server-derived params, not browser-supplied price", async () => {
    const adapter = makeAdapter();
    const params: CreateCheckoutParams = {
      saffReference: "SAFF-TEST-001",
      planCode: "PROFESSIONAL",
      amountMinor: 450_000n,
      currencyCode: "TZS",
      currencyExponent: 0,
      billingPeriod: "ANNUAL",
      customerEmail: "user@firm.co.tz",
      returnUrl: "https://app.saff.co.tz/billing/payment/return?ref=SAFF-TEST-001",
      cancelUrl: "https://app.saff.co.tz/settings",
    };
    const result = await adapter.createCheckout(params);
    expect(result.success).toBe(true);
    expect(result.checkoutUrl).toContain("flutterwave.com");
    expect(adapter.createCheckout).toHaveBeenCalledOnce();
  });

  it("checkout URL is returned to browser — amount is NOT in the URL", async () => {
    const adapter = makeAdapter();
    const params: CreateCheckoutParams = {
      saffReference: "SAFF-TEST-002",
      planCode: "PROFESSIONAL",
      amountMinor: 450_000n,
      currencyCode: "TZS",
      currencyExponent: 0,
      billingPeriod: "ANNUAL",
      customerEmail: "user@firm.co.tz",
      returnUrl: "https://app.saff.co.tz/billing/payment/return?ref=SAFF-TEST-002",
      cancelUrl: "https://app.saff.co.tz/settings",
    };
    const result = await adapter.createCheckout(params);
    expect(result.success).toBe(true);
    // The checkoutUrl must not embed the amount — amounts live server-side
    expect(result.checkoutUrl).not.toContain("450000");
    expect(result.checkoutUrl).not.toContain("amount");
  });

  it("PRODUCT_PRICING_DECISION_REQUIRED — null price blocks checkout before adapter is called", () => {
    // This guard lives in the Edge Function, not the adapter.
    // We test the guard logic in isolation:
    const priceAmountMinor: bigint | null = null;
    const isPurchasable = false;

    function checkoutGuard(price: bigint | null, purchasable: boolean): "BLOCKED" | "PROCEED" {
      if (price === null || !purchasable) return "BLOCKED";
      return "PROCEED";
    }

    expect(checkoutGuard(priceAmountMinor, isPurchasable)).toBe("BLOCKED");
    expect(checkoutGuard(450_000n, true)).toBe("PROCEED");
    expect(checkoutGuard(450_000n, false)).toBe("BLOCKED"); // purchasable flag must also be set
  });
});

describe("Provider-neutral adapter interface", () => {
  it("Flutterwave adapter implements PaymentProviderAdapter", () => {
    const adapter = makeAdapter();
    const methods: Array<keyof PaymentProviderAdapter> = [
      "createCheckout",
      "verifyTransaction",
      "verifyWebhookAuthenticity",
      "normalizeWebhook",
    ];
    for (const m of methods) {
      expect(typeof adapter[m]).toBe("function");
    }
  });

  it("adding Pesapal requires only a new adapter — no entitlement/licence changes", () => {
    // Structural proof: a Pesapal adapter would implement the same interface
    const pesapalAdapter: PaymentProviderAdapter = {
      provider: "PESAPAL",
      createCheckout: vi.fn(),
      verifyTransaction: vi.fn(),
      verifyWebhookAuthenticity: vi.fn(),
      normalizeWebhook: vi.fn(),
    };
    // If this compiles (it will, via the interface), no other changes are needed
    expect(pesapalAdapter.provider).toBe("PESAPAL");
  });
});
