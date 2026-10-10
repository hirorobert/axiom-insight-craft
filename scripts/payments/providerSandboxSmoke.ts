#!/usr/bin/env bun
// Provider SANDBOX smoke test — run by the owner with their own sandbox credentials (never committed, never printed).
// It drives the EXACT adapter code the Edge Functions run (supabase/functions/_shared/payments/providers/*.ts) against
// the provider's sandbox, so the request shapes and the read-back verification are proven against the real API.
//
//   Polar (https://sandbox-api.polar.sh — a separate sandbox account, organization and token):
//     bun scripts/payments/providerSandboxSmoke.ts polar-create        creates a hosted checkout for USD 1.00 (ad-hoc price,
//                                                                      tax-exclusive, discounts off) and prints its URL and id
//     (pay it in the browser with the test card 4242 4242 4242 4242, any future date, any CVC)
//     bun scripts/payments/providerSandboxSmoke.ts polar-verify <checkout id>   reads the order back: expects SUCCEEDED,
//                                                                      net amount 100, USD, this organization and reference
//   Snippe (only if Snippe issues test credentials — no sandbox is documented):
//     bun scripts/payments/providerSandboxSmoke.ts snippe-create <255XXXXXXXXX>   requests TZS 500 to that test number
//     bun scripts/payments/providerSandboxSmoke.ts snippe-verify <reference>      reads the status back
//
// Environment (names only; set them in your shell for the run):
//   POLAR_SANDBOX_ACCESS_TOKEN, POLAR_SANDBOX_ORGANIZATION_ID, POLAR_SANDBOX_PRODUCT_ID (a one-time product in the sandbox)
//   SNIPPE_TEST_API_KEY
// Polar runs only against the sandbox host. Snippe documents no sandbox host: use test credentials only if Snippe issues
// them. Prints outcomes only — never a token, key or full provider payload.
import { createPolarAdapter, POLAR_API_BASE } from "../../supabase/functions/_shared/payments/providers/polar.ts";
import { createSnippeAdapter, SNIPPE_API_BASE } from "../../supabase/functions/_shared/payments/providers/snippe.ts";

const [cmd, arg] = process.argv.slice(2);
const need = (name: string) => { const v = process.env[name]; if (!v) { console.error(`missing ${name}`); process.exit(2); } return v; };
const reference = `SAFF-SMOKE-${Date.now().toString(36).toUpperCase()}`.slice(0, 30);
const billingCustomerId = "00000000-0000-4000-8000-00000000c0de";

if (cmd?.startsWith("polar")) {
  const adapter = createPolarAdapter({
    environment: "sandbox", apiBase: POLAR_API_BASE.sandbox, accessToken: need("POLAR_SANDBOX_ACCESS_TOKEN"), webhookSecret: "whsec_dW51c2Vk",
    organizationId: need("POLAR_SANDBOX_ORGANIZATION_ID"), productIds: { SOLO: need("POLAR_SANDBOX_PRODUCT_ID"), PRACTICE: "", FIRM: "" },
  });
  if (cmd === "polar-create") {
    const r = await adapter.createCheckout({ saffReference: reference, intentId: "smoke", billingCustomerId, amountMinor: 100n, currencyCode: "USD",
      currencyExponent: 2, planCode: "SOLO", planName: "Solo (smoke)", customerEmail: "sandbox-smoke@example.com", customerName: "Sandbox Smoke",
      redirectUrl: "https://cfoclose.com/billing/payment/return?ref=" + reference, phoneNumber: null });
    console.log(r.success ? { created: true, checkoutId: r.providerRef, url: r.checkoutUrl, reference } : { created: false, outcome: r.outcome, error: r.error });
  } else if (cmd === "polar-verify" && arg) {
    const ref = process.argv[4] ?? "";
    const r = await adapter.verifyTransactionByReference({ saffReference: ref, providerCheckoutRef: arg, billingCustomerId }, 100n, "USD");
    console.log(r.verified ? { verified: true, status: r.transaction.normalizedStatus, amountMinor: String(r.transaction.amountMinor), currency: r.transaction.currencyCode, order: r.transaction.providerTransactionId }
      : { verified: false, result: r.result, reason: r.reason });
  } else console.error("usage: polar-create | polar-verify <checkout id> <reference printed by polar-create>");
} else if (cmd?.startsWith("snippe")) {
  const adapter = createSnippeAdapter({ environment: "sandbox", apiBase: SNIPPE_API_BASE, apiKey: need("SNIPPE_TEST_API_KEY"), webhookSecret: "unused", webhookUrl: "https://example.com/unused" });
  if (cmd === "snippe-create" && arg) {
    const r = await adapter.createCheckout({ saffReference: reference, intentId: "smoke", billingCustomerId, amountMinor: 500n, currencyCode: "TZS",
      currencyExponent: 0, planCode: "SOLO", planName: "Solo (smoke)", customerEmail: "sandbox-smoke@example.com", customerName: "Sandbox Smoke",
      redirectUrl: "https://cfoclose.com/billing/payment/return?ref=" + reference, phoneNumber: arg });
    console.log(r.success ? { created: true, reference: r.providerRef, order: reference } : { created: false, outcome: r.outcome, error: r.error });
  } else if (cmd === "snippe-verify" && arg) {
    const r = await adapter.verifyTransactionByReference({ saffReference: process.argv[4] ?? "", providerCheckoutRef: arg, billingCustomerId }, 500n, "TZS");
    console.log(r.verified ? { verified: true, status: r.transaction.normalizedStatus } : { verified: false, result: r.result, reason: r.reason });
  } else console.error("usage: snippe-create <255XXXXXXXXX> | snippe-verify <reference> <order reference>");
} else {
  console.error("usage: polar-create | polar-verify <id> <ref> | snippe-create <phone> | snippe-verify <reference> <ref>");
}
