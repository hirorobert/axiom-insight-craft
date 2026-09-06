/**
 * Ω2-GR1 — Flutterwave Gate B independent-reference-corroboration repair
 * (BLOCKER-2).
 *
 * Codex demonstrated that verifyTransaction() ACCEPTED a missing verified
 * tx_ref by silently falling back to SAFF's own locally-expected reference
 * (`saffReference: rawTxRef || saffRef`), and skipped the mismatch check
 * entirely whenever `rawTxRef` was falsy (`if (rawTxRef && rawTxRef !==
 * saffRef)`). That defeats the entire point of Gate B — independent
 * corroboration from the provider's own systems — since a provider response
 * that says nothing at all about the reference would still "verify".
 *
 * This test imports the ACTUAL Edge Function file directly (no Deno-only
 * remote imports — only relative .ts imports to sibling _shared modules,
 * which Vite/Vitest resolve natively), exactly like edgeMoney.test.ts does
 * for money.ts. FlutterwaveAdapter's constructor reads Deno.env.get(...),
 * so a minimal Deno global is stubbed before construction — this stubs only
 * the two secrets the constructor requires and touches nothing else.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

beforeAll(() => {
  (globalThis as unknown as { Deno: unknown }).Deno = {
    env: {
      get: (key: string): string | undefined =>
        ({
          FLUTTERWAVE_SECRET_KEY: "sk_test_dummy_key_for_tests_only",
          FLUTTERWAVE_WEBHOOK_SECRET: "whsec_dummy_secret_for_tests_only",
        } as Record<string, string>)[key],
    },
  };
});

import { FlutterwaveAdapter } from "../../../../../supabase/functions/_shared/payments/providers/flutterwave";
import { authoriseCommit } from "../../../../../supabase/functions/_shared/payments/authority";

const EXPECTED_MINOR = 100n; // USD $1.00
const EXPECTED_CURRENCY = "USD";
const SAFF_REF = "SAFF-REF-123";
const TX_ID = "provider-tx-1";

function mockFlutterwaveVerifyResponse(data: Record<string, unknown>, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => ({ data }),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function successfulProviderData(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    status: "successful",
    currency: EXPECTED_CURRENCY,
    amount: "1.00",
    tx_ref: SAFF_REF,
    ...overrides,
  };
}

describe("Flutterwave Gate B — independent tx_ref corroboration (Ω2-GR1 BLOCKER-2)", () => {
  it("REJECTS when tx_ref is entirely missing from the provider response — no fallback to saffRef", async () => {
    const adapter = new FlutterwaveAdapter();
    const { tx_ref: _drop, ...data } = successfulProviderData();
    mockFlutterwaveVerifyResponse(data);
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toMatch(/^REFERENCE_MISSING/);
  });

  it("REJECTS when tx_ref is null", async () => {
    const adapter = new FlutterwaveAdapter();
    mockFlutterwaveVerifyResponse(successfulProviderData({ tx_ref: null }));
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toMatch(/^REFERENCE_MISSING/);
  });

  it("REJECTS when tx_ref is an empty string", async () => {
    const adapter = new FlutterwaveAdapter();
    mockFlutterwaveVerifyResponse(successfulProviderData({ tx_ref: "" }));
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toMatch(/^REFERENCE_MISSING/);
  });

  it("REJECTS when tx_ref is whitespace-only", async () => {
    const adapter = new FlutterwaveAdapter();
    mockFlutterwaveVerifyResponse(successfulProviderData({ tx_ref: "   " }));
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toMatch(/^REFERENCE_MISSING/);
  });

  it("REJECTS when tx_ref does not match SAFF's checkout reference", async () => {
    const adapter = new FlutterwaveAdapter();
    mockFlutterwaveVerifyResponse(successfulProviderData({ tx_ref: "SOME-OTHER-REFERENCE" }));
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toMatch(/^REFERENCE_MISMATCH/);
  });

  it("VERIFIES when tx_ref exactly matches, amount and currency also match", async () => {
    const adapter = new FlutterwaveAdapter();
    mockFlutterwaveVerifyResponse(successfulProviderData());
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.transaction.saffReference).toBe(SAFF_REF);
      expect(result.transaction.amountMinor).toBe(EXPECTED_MINOR);
      expect(result.transaction.currencyCode).toBe(EXPECTED_CURRENCY);
    }
  });

  it("correct tx_ref but WRONG amount -> AMOUNT_MISMATCH, never verified", async () => {
    const adapter = new FlutterwaveAdapter();
    mockFlutterwaveVerifyResponse(successfulProviderData({ amount: "2.00" }));
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toMatch(/^AMOUNT_MISMATCH/);
  });

  it("correct tx_ref but WRONG currency -> CURRENCY_MISMATCH, never verified", async () => {
    const adapter = new FlutterwaveAdapter();
    mockFlutterwaveVerifyResponse(successfulProviderData({ currency: "KES" }));
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toMatch(/^CURRENCY_MISMATCH/);
  });

  it("correct tx_ref but NON-SUCCESS provider status -> Gate B corroborates identity, but authoriseCommit refuses the commit", async () => {
    const adapter = new FlutterwaveAdapter();
    mockFlutterwaveVerifyResponse(successfulProviderData({ status: "failed" }));
    const result = await adapter.verifyTransaction(TX_ID, EXPECTED_MINOR, EXPECTED_CURRENCY, SAFF_REF);
    expect(result.verified).toBe(true); // reference/amount/currency all corroborate
    if (result.verified) {
      expect(result.transaction.normalizedStatus).toBe("FAILED");
      const authority = authoriseCommit(
        {
          id: "intent-1",
          expected_amount_minor: EXPECTED_MINOR,
          currency_code: EXPECTED_CURRENCY,
          saff_reference: SAFF_REF,
          status: "PENDING",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
        result.transaction,
      );
      expect(authority.authorised).toBe(false);
      if (!authority.authorised) expect(authority.reason).toMatch(/^NON_SUCCESS/);
    }
  });
});
